import type { AddressCandidate } from "@brikell/shared";
import {
  buildReportPrompt,
  managedReportCanonicalPath,
  managedReportMarkdownPath,
} from "./prompt";
import { readAppEnv } from "../validation/env";
import { createErrorDiagnostic } from "@brikell/shared";
import {
  extractCanonicalReportFromOutputs,
  type ExtractCanonicalOutcome,
  type ManagedRunnerOutput,
} from "./canonical-output";
import type { ReportRunnerProgress } from "./runner-types";
import type { ReportV1 } from "@brikell/shared";
import type { McpToolCallRecord } from "@brikell/shared";
import { checkProvenance, collectProvenance } from "@brikell/shared";
import { ensureManagedSkillEnvironment, runManagedMessage } from "./managed/runner";
import type { ManagedMessageRunResult } from "./managed/runner";
import type { UploadedVaultDoc } from "../vault/uploaded-docs";

/**
 * Default wall-clock cap on a managed report run (45 min).
 *
 * Why a single overall watchdog: the bridge already bounds individual MCP
 * fetches (90s × 3 retries) and the SSE phase-1 idle wait (90s). But silent
 * hangs can sneak through other await points — most notably
 * beta.sessions.events.send (posting a tool result back) on a zombie TCP
 * connection. Without an outer deadline the bridge sits until Vercel's 60-min
 * function-duration cap kills the lambda, leaving the report in `running` state
 * forever. 45 min is generous headroom for the slowest legitimate runs we've
 * observed (~10 min) while staying well under the Vercel cap so the user gets
 * a clean failure instead of an orphaned job.
 */
const DEFAULT_MANAGED_AGENT_RUN_TIMEOUT_MS = 45 * 60 * 1000;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export type ManagedRunnerResult = {
  markdown?: string;
  canonicalReport?: ReportV1;
  canonicalSource?: "runner" | "mock";
  canonicalAbsentReason?: string;
  sessionId?: string;
  runLogPath?: string;
  mcpToolCalls: McpToolCallRecord[];
};

export type RunReportAgentOptions = {
  uploadedDocuments?: ReadonlyArray<UploadedVaultDoc>;
  signal?: AbortSignal;
};

export type RunReportAgent = (
  jobId: string,
  address: AddressCandidate,
  onProgress?: ReportRunnerProgress,
  options?: RunReportAgentOptions,
) => Promise<ManagedRunnerResult>;

/**
 * Injectable runner contract. Production wires `liveReportRunner`. Tests
 * inject a `staticReportRunner(...)` or `replayReportRunner(...)` fixture so
 * the worker job pipeline can be exercised without spending Anthropic dollars
 * or initialising the managed-skill runtime.
 */
export type ReportRunner = {
  ensureReady: () => Promise<void>;
  run: RunReportAgent;
};

export type { ReportRunnerProgress } from "./runner-types";

export async function ensureReportAgentRuntimeReady(): Promise<void> {
  await ensureManagedSkillEnvironment();
}

type ManagedRunEvent = {
  kind: "agent" | "error" | "event" | "idle" | "model" | "result" | "running" | "thinking" | "tool" | "user";
  message: string;
  details?: unknown;
};

const KNOWN_PROVIDER_PREFIXES = ["plandata", "datafordeler", "dataforsyningen", "supabase"] as const;

export function deriveProvider(toolName: string): string {
  const lower = toolName.toLowerCase();
  for (const prefix of KNOWN_PROVIDER_PREFIXES) {
    if (lower.startsWith(`${prefix}.`) || lower.startsWith(`${prefix}_`) || lower.includes(prefix)) {
      return prefix;
    }
  }
  if (lower.includes("/")) return lower.split("/")[0]!;
  if (lower.includes(".")) return lower.split(".")[0]!;
  return "managed-agent";
}

type ToolDetails = { input?: unknown; server?: unknown; [key: string]: unknown };
type ResultDetails = { ok?: unknown; content?: unknown; [key: string]: unknown };

export function buildToolCallBuffer() {
  const records: McpToolCallRecord[] = [];
  let openIndex: number | undefined;

  function ingest(event: ManagedRunEvent): void {
    if (event.kind === "tool") {
      if (openIndex !== undefined) {
        records[openIndex]!.ok = false;
        records[openIndex]!.diagnostic = "no result event before next tool call";
      }
      const toolName = (event.message || "").trim() || "managed-agent.tool";
      const details = (event.details ?? {}) as ToolDetails;
      records.push({
        toolName,
        provider: deriveProvider(toolName),
        args: typeof details.input !== "undefined" ? details.input : details,
        sourceProvenance: typeof details.server !== "undefined" ? { server: details.server } : undefined,
        fetchedAt: new Date().toISOString(),
        ok: true,
      });
      openIndex = records.length - 1;
      return;
    }
    if (event.kind === "result") {
      const details = (event.details ?? {}) as ResultDetails;
      const ok = typeof details.ok === "boolean" ? details.ok : true;
      const resultPayload = typeof details.content !== "undefined" ? details.content : details;
      if (openIndex !== undefined) {
        const record = records[openIndex]!;
        record.result = resultPayload;
        record.ok = ok;
        if (!ok && typeof event.message === "string" && event.message.trim().length > 0) {
          record.diagnostic = event.message;
        }
        if (ok) {
          const check = checkProvenance(resultPayload);
          if (check.ok) {
            const refs = collectProvenance(resultPayload);
            record.sourceProvenance = {
              ...(record.sourceProvenance ?? {}),
              ref: check.ref,
              dataSources: refs.sources,
              upstreamIds: refs.upstreamIds,
            };
          } else {
            record.ok = false;
            record.diagnostic = `bridge_missing_provenance: ${check.reason}`;
          }
        }
        openIndex = undefined;
      } else {
        records.push({
          toolName: event.message || "result",
          provider: "managed-agent",
          result: resultPayload,
          fetchedAt: new Date().toISOString(),
          ok,
          diagnostic: ok ? undefined : event.message || undefined,
        });
      }
    }
  }

  function snapshot(): McpToolCallRecord[] {
    return records.map((record) => ({ ...record }));
  }

  return { ingest, snapshot };
}

export type { ManagedRunEvent };

export const runReportAgent: RunReportAgent = async (
  jobId,
  address,
  onProgress,
  options = {},
) => {
  const env = readAppEnv();
  const prompt = buildReportPrompt(jobId, address, { uploadedDocuments: options.uploadedDocuments });

  const throwIfAborted = () => {
    if (options.signal?.aborted) {
      throw new Error("Report runner cancelled before completion.");
    }
  };

  let phase = "announce-runner-start";
  const toolCallBuffer = buildToolCallBuffer();
  try {
    throwIfAborted();
    await onProgress?.("Starting managed report runner.");
    phase = "run-managed-message";
    // Defense-in-depth wall-clock cap on the entire managed run. The bridge
    // already has per-MCP-call timeouts, retry, and an SSE phase-1 idle
    // watchdog — but those only cover specific await points. If a hang lives
    // anywhere else (e.g. the consumer awaiting beta.sessions.events.send to
    // post a tool result back to Anthropic), nothing else catches it before
    // Vercel's 60-min function-duration cap kills the lambda. This Promise.race
    // bounds the whole thing.
    const overallTimeoutMs = readPositiveIntegerEnv(
      "MANAGED_AGENT_RUN_TIMEOUT_MS",
      DEFAULT_MANAGED_AGENT_RUN_TIMEOUT_MS,
    );
    const racers: Promise<ManagedMessageRunResult>[] = [
      runManagedMessage(prompt, {
        outputMirrorDir: env.MANAGED_AGENT_OUTPUT_MIRROR_DIR,
        runOutputDir: env.MANAGED_AGENT_RUN_OUTPUT_DIR,
        onEvent: async (event) => {
          throwIfAborted();
          toolCallBuffer.ingest(event);
          if (event.kind === "tool" || event.kind === "result" || event.kind === "agent") {
            await onProgress?.(event.message);
          }
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Managed runner exceeded MANAGED_AGENT_RUN_TIMEOUT_MS=${overallTimeoutMs}ms without producing a result. Aborting before the Vercel function-duration cap kills the lambda.`,
              ),
            ),
          overallTimeoutMs,
        ).unref(),
      ),
    ];
    if (options.signal) {
      racers.push(
        new Promise<never>((_, reject) => {
          if (options.signal!.aborted) {
            reject(new Error("Report runner cancelled before managed message could start."));
            return;
          }
          options.signal!.addEventListener(
            "abort",
            () => reject(new Error("Report runner cancelled while managed message was in flight.")),
            { once: true },
          );
        }),
      );
    }
    const result = await Promise.race(racers);

    phase = "resolve-canonical-output";
    throwIfAborted();
    const canonicalOutcome = await extractCanonicalReportFromOutputs(
      result.outputs,
      managedReportCanonicalPath(jobId),
      onProgress,
    );

    phase = "resolve-markdown-output";
    const markdown = await readMarkdownOutput(result.outputs, managedReportMarkdownPath(jobId));

    // No throw on the "neither produced" case. A run that ends without final
    // output files is a soft failure so the service layer can mark the job
    // complete-with-warnings and the user gets a friendly message instead of a
    // raw technical error.
    return {
      markdown,
      canonicalReport: canonicalOutcome.kind === "found" ? canonicalOutcome.report : undefined,
      canonicalSource: canonicalOutcome.kind === "found" ? "runner" : undefined,
      canonicalAbsentReason:
        canonicalOutcome.kind === "found" ? undefined : describeExtractOutcome(canonicalOutcome),
      sessionId: result.sessionId,
      runLogPath: result.runLogPath,
      mcpToolCalls: toolCallBuffer.snapshot(),
    };
  } catch (error) {
    console.error("Report runner failed.", {
      jobId,
      phase,
      error: createErrorDiagnostic(error),
    });
    throw error;
  }
};

function describeExtractOutcome(outcome: ExtractCanonicalOutcome): string {
  switch (outcome.kind) {
    case "absent":
      return "Runner did not produce a canonical V1 report.json file.";
    case "unreadable":
      return "Canonical V1 report.json could not be read from the managed runtime.";
    case "parse_failed":
      return "Canonical V1 report.json was not valid JSON.";
    case "validation_failed":
      return "Canonical V1 report.json failed schema validation.";
    case "found":
      return "Canonical V1 report.json was produced.";
  }
}

/**
 * The production runner. Performs managed-skill environment setup, then
 * executes the live agent run via Anthropic. Tests inject `staticReportRunner`
 * or `replayReportRunner` from `tests/fixtures/runners/`.
 */
export const liveReportRunner: ReportRunner = {
  ensureReady: ensureReportAgentRuntimeReady,
  run: runReportAgent,
};

async function readMarkdownOutput(
  outputs: ManagedRunnerOutput[],
  expectedManagedPath: string,
): Promise<string | undefined> {
  const output = outputs.find((entry) => entry.managedPath === expectedManagedPath);
  if (!output) return undefined;
  if (typeof output.content === "string" && output.content.length > 0) return output.content;
  if (!output.localPath) return undefined;
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  try {
    return await readFile(resolve(output.localPath), "utf8");
  } catch {
    return undefined;
  }
}
