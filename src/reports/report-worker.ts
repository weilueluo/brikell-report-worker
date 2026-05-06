import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createErrorDiagnostic } from "@brikell/shared";
import { CancellationState } from "../cancellation";
import { createStores } from "../storage";
import { readAppEnv } from "../validation/env";
import { formatJobErrorForUser } from "@brikell/shared";
import { eventForStatus } from "@brikell/shared";
import { emitReportEvent } from "./report-observability";
import { startReportJob } from "./report-service";
import type { ReportRunner } from "../agent/runner-client";
import type { ReportJob } from "@brikell/shared";

export type ReportWorkerLogger = Pick<Console, "error" | "log" | "warn">;

export type ReportWorkerConfig = {
  workerId: string;
  pollMs: number;
  heartbeatMs: number;
  staleAfterMs: number;
  concurrency: number;
};

export type ReportWorkerRunOptions = Partial<ReportWorkerConfig> & {
  once?: boolean;
  signal?: AbortSignal;
  logger?: ReportWorkerLogger;
  /**
   * Inject a runner. Production omits this and the live runner is used.
   * Tests inject `staticReportRunner(...)` or `replayReportRunner(...)` so the
   * worker pipeline can be exercised without spending Anthropic dollars.
   */
  runner?: ReportRunner;
  /**
   * Scope the worker loop to a single owner. When set, both
   * `failStaleRunningReportJobs` and `claimNextQueuedReportJob` are restricted
   * to jobs owned by this client. Used by integration tests so parallel runs
   * against the same Supabase don't steal each other's queued jobs.
   */
  ownerClientId?: string;
};

export type ReportWorkerOnceResult =
  | { kind: "idle"; staleFailed: number }
  | { kind: "processed"; jobId: string; status: ReportJob["status"]; staleFailed: number };

const STALE_ERROR_MESSAGE = "Report worker heartbeat timed out.";
const STALE_USER_MESSAGE = "The report worker stopped responding. Please regenerate the report.";

export function readReportWorkerConfig(overrides: Partial<ReportWorkerConfig> = {}): ReportWorkerConfig {
  const env = readAppEnv();
  return {
    workerId: overrides.workerId ?? env.BRIKELL_REPORT_WORKER_ID ?? `${hostname()}-${process.pid}`,
    pollMs: overrides.pollMs ?? env.BRIKELL_REPORT_WORKER_POLL_MS,
    heartbeatMs: overrides.heartbeatMs ?? env.BRIKELL_REPORT_WORKER_HEARTBEAT_MS,
    staleAfterMs: overrides.staleAfterMs ?? env.BRIKELL_REPORT_WORKER_STALE_MS,
    concurrency: overrides.concurrency ?? env.BRIKELL_REPORT_WORKER_CONCURRENCY,
  };
}

export async function runReportWorker(options: ReportWorkerRunOptions = {}): Promise<void> {
  const logger = options.logger ?? console;
  const config = readReportWorkerConfig(options);
  if (config.concurrency !== 1) {
    throw new Error("BRIKELL_REPORT_WORKER_CONCURRENCY must be 1 for the first worker release.");
  }

  logWorkerEvent(logger, "log", "report_worker_started", {
    workerId: config.workerId,
    pollMs: config.pollMs,
    heartbeatMs: config.heartbeatMs,
    staleAfterMs: config.staleAfterMs,
    once: options.once === true,
  });

  do {
    await runReportWorkerOnce({
      ...config,
      logger,
      runner: options.runner,
      ownerClientId: options.ownerClientId,
    });
    if (options.once) return;
    await sleep(config.pollMs, options.signal);
  } while (!options.signal?.aborted);
}

export async function runReportWorkerOnce(options: ReportWorkerRunOptions = {}): Promise<ReportWorkerOnceResult> {
  const logger = options.logger ?? console;
  const config = readReportWorkerConfig(options);
  if (config.concurrency !== 1) {
    throw new Error("BRIKELL_REPORT_WORKER_CONCURRENCY must be 1 for the first worker release.");
  }

  const { jobs } = createStores();
  const stale = await jobs.failStaleRunningReportJobs({
    staleAfterMs: config.staleAfterMs,
    errorMessage: STALE_ERROR_MESSAGE,
    userFacingMessage: STALE_USER_MESSAGE,
    eventMessage: eventForStatus("failed"),
    ownerClientId: options.ownerClientId,
  });
  if (stale.length > 0) {
    logWorkerEvent(logger, "warn", "report_worker_failed_stale_jobs", {
      workerId: config.workerId,
      count: stale.length,
      jobIds: stale.map((job) => job.id),
    });
  }

  const claimed = await jobs.claimNextQueuedReportJob(config.workerId, {
    ownerClientId: options.ownerClientId,
  });
  if (!claimed) {
    logWorkerEvent(logger, "log", "report_worker_idle", { workerId: config.workerId });
    return { kind: "idle", staleFailed: stale.length };
  }

  emitReportEvent(logger, "report_worker_claimed_job", {
    workerId: config.workerId,
    jobId: claimed.id,
    attempt: claimed.worker?.attempt,
  });

  const stopHeartbeat = startHeartbeat(claimed.id, config, logger);
  const cancellation = new CancellationState(options.signal);
  try {
    await startReportJob(claimed.id, undefined, {
      logger,
      workerId: config.workerId,
      runner: options.runner,
      signal: cancellation.signal,
    });
  } catch (error) {
    await failClaimedJob(claimed.id, error);
    logWorkerEvent(logger, "error", "report_worker_job_error", {
      workerId: config.workerId,
      jobId: claimed.id,
      cancelled: cancellation.requested,
      cancelReason: cancellation.reason,
      error: createErrorDiagnostic(error),
    });
  } finally {
    stopHeartbeat();
  }

  const completed = await jobs.get(claimed.id);
  const status = completed?.status ?? claimed.status;
  emitReportEvent(logger, "report_worker_finished_job", {
    workerId: config.workerId,
    jobId: claimed.id,
    status,
  });
  return { kind: "processed", jobId: claimed.id, status, staleFailed: stale.length };
}

async function failClaimedJob(id: string, error: unknown): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const { jobs } = createStores();
  await jobs.mutate(id, (job) => {
    if (job.status === "complete") return job;
    return {
      ...job,
      status: "failed",
      errorMessage,
      userFacingMessage: formatJobErrorForUser(errorMessage),
      events: [...job.events, { at: new Date().toISOString(), message: eventForStatus("failed") }],
    };
  });
}

function startHeartbeat(
  jobId: string,
  config: ReportWorkerConfig,
  logger: ReportWorkerLogger,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const beat = async () => {
    if (stopped) return;
    try {
      const { jobs } = createStores();
      await jobs.heartbeatReportJob(jobId, config.workerId);
      logWorkerEvent(logger, "log", "report_worker_heartbeat", {
        workerId: config.workerId,
        jobId,
      });
    } catch (error) {
      emitReportEvent(logger, "report_worker_heartbeat_error", {
        workerId: config.workerId,
        jobId,
        error,
      }, "error");
    } finally {
      if (!stopped) {
        timer = setTimeout(beat, config.heartbeatMs);
        timer.unref?.();
      }
    }
  };

  timer = setTimeout(beat, config.heartbeatMs);
  timer.unref?.();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, signal ? { signal } : undefined);
  } catch (error) {
    if (signal?.aborted && error instanceof Error && error.name === "AbortError") return;
    throw error;
  }
}

function logWorkerEvent(
  logger: ReportWorkerLogger,
  level: "error" | "log" | "warn",
  event: string,
  fields: Record<string, unknown>,
): void {
  logger[level]("Report worker event.", { event, ...fields });
}
