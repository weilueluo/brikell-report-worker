import { randomUUID } from "node:crypto";
import type { AddressCandidate } from "@brikell/shared";
import { enrichAddressCandidateCoordinates } from "../address/service";
import { liveReportRunner, type ReportRunner } from "../agent/runner-client";
import {
  AssignmentNotFoundError,
  applyAssignmentReportStatus,
  getAssignmentForOwner,
  linkAssignmentReportJob,
} from "../assignments/assignment-service";
import { createErrorDiagnostic } from "@brikell/shared";
import { createStores } from "../storage";
import { readAppEnv } from "../validation/env";
import { recordMcpToolCallEvidence, recordReportArtifacts, listVaultItemsForAssignment } from "../vault/vault-service";
import type { McpToolCallRecord, ReportArtifactInput, VaultItem } from "@brikell/shared";
import { linkSourceDocumentsToVault } from "../vault/link-source-documents";
import { pickUploadedVaultDocsForPrompt, type UploadedVaultDoc } from "../vault/uploaded-docs";
import { renderReportPdf } from "./pdf";
import { describeCanonicalOutcome, evaluateCanonical, summarizeCanonicalRequirementFailure } from "./canonical-evaluation";
import { createInitialJob, eventForStatus, ReportActiveJobConflictError } from "@brikell/shared";
import { formatJobErrorForUser } from "@brikell/shared";
import type { ReportJob, ReportReviewAction, ReportStatus, ReportWarning } from "@brikell/shared";
import { isReviewableReportStatus, isTerminalReportStatus } from "./report-status";
import {
  emitReportEvent,
  type ReportObservabilityLogger,
} from "./report-observability";

const runningJobs = new Set<string>();

const CANONICAL_CONTENT_TYPE = "application/json; charset=utf-8";

export type ReportJobUpdateSink = (job: ReportJob) => void | Promise<void>;

export type CreateReportOptions = {
  assignmentId?: string;
  ownerClientId: string;
  logger?: ReportObservabilityLogger;
};

export type ReviewReportInput = {
  action: ReportReviewAction;
  reviewerName?: string;
  note?: string;
  logger?: ReportObservabilityLogger;
};

export class ReportNotFoundError extends Error {
  readonly code = "report_not_found";

  constructor(id: string) {
    super(`Report job not found: ${id}`);
    this.name = "ReportNotFoundError";
  }
}

export class ReportReviewTransitionError extends Error {
  readonly code = "report_review_invalid_transition";

  constructor(
    public readonly jobId: string,
    public readonly status: ReportStatus,
    public readonly action: ReportReviewAction,
  ) {
    super(`Cannot ${action} a report job while it is ${status}.`);
    this.name = "ReportReviewTransitionError";
  }
}

export async function createReport(
  address: AddressCandidate,
  options: CreateReportOptions,
): Promise<ReportJob> {
  return createQueuedReport(address, options);
}

export async function createReportWithProgress(
  address: AddressCandidate,
  onUpdate: ReportJobUpdateSink,
  options: CreateReportOptions,
): Promise<ReportJob> {
  const job = await createQueuedReport(address, options);
  await onUpdate(job);
  return job;
}

export async function getReport(id: string): Promise<ReportJob | undefined> {
  const { jobs } = createStores();
  return jobs.get(id);
}

export async function getReportForOwner(
  id: string,
  ownerClientId: string,
  options: { logger?: ReportObservabilityLogger; route?: string; action?: string } = {},
): Promise<ReportJob | undefined> {
  const job = await getReport(id);
  if (!job) return undefined;
  if (job.ownerClientId === ownerClientId) return job;
  emitReportEvent(options.logger ?? console, "report_owner_access_denied", {
    route: options.route ?? options.action ?? "report_service",
    action: options.action,
    reason: "owner_mismatch",
  }, "warn");
  return undefined;
}

export async function listReportsForOwner(
  ownerClientId: string,
  filter: { assignmentId?: string; status?: ReportStatus | readonly ReportStatus[]; limit?: number } = {},
): Promise<ReportJob[]> {
  const { jobs } = createStores();
  return jobs.list({ ...filter, ownerClientId });
}

export async function reviewReportJob(
  id: string,
  ownerClientId: string,
  input: ReviewReportInput,
): Promise<ReportJob> {
  const logger = input.logger ?? console;
  const job = await getReportForOwner(id, ownerClientId, { logger, action: "review_report" });
  if (!job) throw new ReportNotFoundError(id);
  if (!isReviewableReportStatus(job.status)) {
    emitReportEvent(logger, "report_review_invalid_transition", {
      jobId: id,
      assignmentId: job.assignmentId,
      fromStatus: job.status,
      reviewAction: input.action,
    }, "warn");
    throw new ReportReviewTransitionError(id, job.status, input.action);
  }

  const decision: NonNullable<ReportJob["review"]>["decision"] = input.action === "approve" ? "approved" : "rejected";
  const nextStatus = input.action === "approve" ? "complete" : "rejected";
  const reviewedAt = new Date().toISOString();
  const review = {
    decision,
    reviewedAt,
    ...(input.reviewerName ? { reviewerName: input.reviewerName } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
  const reviewed = await transitionReportJob(id, nextStatus, {
    logger,
    patch: { review },
  });

  if (input.action === "approve") {
    await recordVaultArtifactsForJob(reviewed, logger);
    await mirrorAssignmentStatusForJob(reviewed, "complete", logger);
    emitReportEvent(logger, "report_review_approved", {
      jobId: reviewed.id,
      assignmentId: reviewed.assignmentId,
      reviewAction: "approve",
    });
  } else {
    await mirrorAssignmentStatusForJob(reviewed, "rejected", logger);
    emitReportEvent(logger, "report_review_rejected", {
      jobId: reviewed.id,
      assignmentId: reviewed.assignmentId,
      reviewAction: "reject",
    });
  }

  return reviewed;
}

export async function startReportJob(
  id: string,
  onUpdate?: ReportJobUpdateSink,
  options: {
    logger?: ReportObservabilityLogger;
    workerId?: string;
    runner?: ReportRunner;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const logger = options.logger ?? console;
  const runner = options.runner ?? liveReportRunner;
  if (runningJobs.has(id)) {
    const job = await getReport(id);
    if (job) await onUpdate?.(job);
    return;
  }
  runningJobs.add(id);
  const { jobs, artifacts } = createStores();

  try {
    const job = await jobs.get(id);
    if (!job) throw new Error(`Report job not found: ${id}`);
    if (isTerminalReportStatus(job.status) || job.status === "awaiting_review") {
      await notifyUpdate(job, onUpdate);
      return;
    }

    await runner.ensureReady();
    await notifyUpdate(await transitionReportJob(id, "running", { logger }), onUpdate);
    const uploadedDocuments = await collectUploadedVaultDocsForJob(job).catch((error) => {
      console.warn("Could not load uploaded vault documents for prompt; continuing without them.", {
        jobId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });
    const runnerResult = await runner.run(
      id,
      job.address,
      async (message) => {
        await notifyUpdate(await appendEvent(id, sanitizeProgressMessage(message)), onUpdate);
      },
      { uploadedDocuments, signal: options.signal },
    );

    const canonicalOutcome = evaluateCanonical({
      canonicalReport: runnerResult.canonicalReport,
      canonicalAbsentReason: runnerResult.canonicalAbsentReason,
      expectedAddressLabel: job.address.label,
    });
    if (canonicalOutcome.kind === "render_failed") {
      console.error("Canonical V1 rendering failed; falling back to runner Markdown.", {
        jobId: id,
        reason: canonicalOutcome.reason,
      });
    }
    await notifyUpdate(await appendEvent(id, describeCanonicalOutcome(canonicalOutcome)), onUpdate);

    if (
      canonicalOutcome.kind !== "rendered"
      && readAppEnv().BRIKELL_REPORT_REQUIRE_CANONICAL === "on"
    ) {
      throw new Error(summarizeCanonicalRequirementFailure(canonicalOutcome));
    }

    const canonicalRender =
      canonicalOutcome.kind === "rendered"
        ? { markdown: canonicalOutcome.markdown, json: canonicalOutcome.json }
        : undefined;

    const markdown = canonicalRender?.markdown ?? runnerResult.markdown;

    if (markdown === undefined) {
      const warning: ReportWarning = {
        code: "no_artifact_submitted",
        message:
          "The report agent finished without delivering a report file. Please regenerate the report.",
        detail: runnerResult.canonicalAbsentReason ?? "Runner returned no Markdown and no canonical V1 report.",
      };
      emitReportEvent(logger, "report_runner_no_artifact_failed", {
        jobId: id,
        assignmentId: job.assignmentId,
        warningCode: warning.code,
      }, "warn");
      await notifyUpdate(
        await transitionReportJob(id, "failed", {
          logger,
          patch: (current) => ({
            warnings: [...(current.warnings ?? []), warning],
            errorMessage: warning.detail,
            userFacingMessage: warning.message,
          }),
          eventMessages: ["Report agent finished without delivering a report file."],
        }),
        onUpdate,
      );
      const interimJobForAssignment = await jobs.get(id);
      if (interimJobForAssignment?.assignmentId) {
        await mirrorAssignmentStatusForJob(interimJobForAssignment, "failed", logger);
      }
      return;
    }

    await notifyUpdate(await transitionReportJob(id, "rendering_pdf", { logger }), onUpdate);
    const stem = filenameStem(job.address.label);
    const markdownKey = `${id}.md`;
    const pdfKey = `${id}.pdf`;
    const markdownBytes = new Uint8Array(Buffer.from(markdown, "utf8"));
    const pdfBytes = await renderReportPdf(markdown);
    await artifacts.putArtifact({
      key: markdownKey,
      contentType: "text/markdown; charset=utf-8",
      filename: `${stem}-brikell-report.md`,
      bytes: markdownBytes,
    });
    emitReportEvent(logger, "report_artifact_persisted", {
      jobId: id,
      assignmentId: job.assignmentId,
      artifactKind: "report_markdown",
    });
    await artifacts.putArtifact({
      key: pdfKey,
      contentType: "application/pdf",
      filename: `${stem}-brikell-report.pdf`,
      bytes: pdfBytes,
    });
    emitReportEvent(logger, "report_artifact_persisted", {
      jobId: id,
      assignmentId: job.assignmentId,
      artifactKind: "report_pdf",
    });

    let canonicalArtifactKey: string | undefined;
    let canonicalArtifactInline: ReportJob["canonicalArtifact"];
    if (canonicalRender) {
      canonicalArtifactKey = `${id}.json`;
      const canonicalBytes = new Uint8Array(Buffer.from(canonicalRender.json, "utf8"));
      const canonicalFilename = `${stem}-brikell-report.canonical.json`;
      await artifacts.putArtifact({
        key: canonicalArtifactKey,
        contentType: CANONICAL_CONTENT_TYPE,
        filename: canonicalFilename,
        bytes: canonicalBytes,
      });
      emitReportEvent(logger, "report_artifact_persisted", {
        jobId: id,
        assignmentId: job.assignmentId,
        artifactKind: "report_canonical_json",
      });
      canonicalArtifactInline = {
        contentType: CANONICAL_CONTENT_TYPE,
        filename: canonicalFilename,
        content: canonicalRender.json,
        encoding: "utf8",
      };
    }

    const interimJob = await jobs.mutate(id, (current) => ({
      ...current,
      markdownArtifactKey: markdownKey,
      pdfArtifactKey: pdfKey,
      canonicalArtifactKey,
    }));

    if (interimJob.assignmentId) {
      const recordedMcpItems = await recordMcpToolCallEvidenceForJob(interimJob, runnerResult.mcpToolCalls);
      if (canonicalRender && runnerResult.canonicalReport) {
        const allVaultItems = await listVaultItemsForAssignment(interimJob.ownerClientId, interimJob.assignmentId).catch((error) => {
          console.warn("Could not list vault items for source-document linking; continuing without it.", {
            jobId: id,
            error: error instanceof Error ? error.message : String(error),
          });
          return [] as VaultItem[];
        });
        const linkPool = recordedMcpItems.length > 0
          ? [...recordedMcpItems, ...allVaultItems.filter((item) => !recordedMcpItems.some((mcp) => mcp.id === item.id))]
          : allVaultItems;
        const linkResult = linkSourceDocumentsToVault(runnerResult.canonicalReport, linkPool);
        if (linkResult.linked > 0 && canonicalArtifactKey && canonicalArtifactInline) {
          const reSerialized = JSON.stringify(linkResult.report, null, 2);
          const reBytes = new Uint8Array(Buffer.from(reSerialized, "utf8"));
          await artifacts.putArtifact({
            key: canonicalArtifactKey,
            contentType: CANONICAL_CONTENT_TYPE,
            filename: canonicalArtifactInline.filename,
            bytes: reBytes,
          });
          emitReportEvent(logger, "report_artifact_persisted", {
            jobId: id,
            assignmentId: interimJob.assignmentId,
            artifactKind: "report_canonical_json",
          });
          canonicalArtifactInline = { ...canonicalArtifactInline, content: reSerialized };
          await notifyUpdate(
            await appendEvent(
              id,
              `Linked ${linkResult.linked} canonical source document(s) to Vault evidence.`,
            ),
            onUpdate,
          );
        }
      }
    }

    await notifyUpdate(
      await transitionReportJob(id, "awaiting_review", {
        logger,
        patch: {
          markdownArtifact: {
            contentType: "text/markdown; charset=utf-8",
            filename: `${stem}-brikell-report.md`,
            content: markdown,
            encoding: "utf8",
          },
          pdfArtifact: {
            contentType: "application/pdf",
            filename: `${stem}-brikell-report.pdf`,
            content: Buffer.from(pdfBytes).toString("base64"),
            encoding: "base64",
          },
          canonicalArtifact: canonicalArtifactInline,
        },
      }),
      onUpdate,
    );
    const reviewReadyJob = await jobs.get(id);
    if (reviewReadyJob?.assignmentId) {
      await mirrorAssignmentStatusForJob(reviewReadyJob, "awaiting_review", logger);
    }
  } catch (error) {
    const currentJob = await getReport(id).catch(() => undefined);
    if (currentJob && (isTerminalReportStatus(currentJob.status) || currentJob.status === "awaiting_review")) {
      console.error("Post-final-state persistence failed; not regressing report job to failed.", {
        jobId: id,
        status: currentJob.status,
        error: createErrorDiagnostic(error),
      });
    } else {
      console.error("Report job failed.", {
        jobId: id,
        error: createErrorDiagnostic(error),
      });
      const failed = await markJobFailed(id, sanitizeProgressMessage(error instanceof Error ? error.message : String(error)), logger);
      if (failed) await notifyUpdate(failed, onUpdate);
      if (failed) await mirrorAssignmentStatusForJob(failed, "failed", logger);
    }
  } finally {
    runningJobs.delete(id);
  }
}

async function createQueuedReport(address: AddressCandidate, options: CreateReportOptions): Promise<ReportJob> {
  const logger = options.logger ?? console;
  const { jobs } = createStores();
  await ensureAssignmentLinkable(options);
  const reportAddress = await prepareAddressForReport(address);
  const initialJob = createInitialJob({
    id: randomUUID(),
    address: reportAddress,
    assignmentId: options.assignmentId,
    ownerClientId: options.ownerClientId,
  });
  let job: ReportJob;
  try {
    job = options.assignmentId
      ? await jobs.createAssignmentReportJob(initialJob)
      : await jobs.create(initialJob);
  } catch (error) {
    if (error instanceof ReportActiveJobConflictError) {
      emitReportEvent(logger, "report_active_job_conflict", {
        assignmentId: error.input.assignmentId,
        conflictReason: "active_assignment_report_exists",
      }, "warn");
    }
    throw error;
  }
  emitReportEvent(logger, "report_job_created", {
    jobId: job.id,
    assignmentId: job.assignmentId,
    status: job.status,
  });
  await linkAssignmentToJob(job, options);
  return job;
}

type ReportJobPatch = Partial<Omit<ReportJob, "id" | "createdAt" | "updatedAt" | "status" | "events">>;

async function transitionReportJob(
  id: string,
  status: ReportStatus,
  options: {
    logger?: ReportObservabilityLogger;
    patch?: ReportJobPatch | ((current: ReportJob) => ReportJobPatch);
    eventMessages?: readonly string[];
  } = {},
): Promise<ReportJob> {
  const { jobs } = createStores();
  let fromStatus: ReportStatus | undefined;
  const next = await jobs.mutate(id, (job) => {
    fromStatus = job.status;
    const patch = typeof options.patch === "function" ? options.patch(job) : options.patch;
    const messages = [...(options.eventMessages ?? []), eventForStatus(status)];
    return {
      ...job,
      ...patch,
      status,
      events: appendReportEvents(job.events, messages),
    };
  });
  if (fromStatus && fromStatus !== status) {
    emitReportEvent(options.logger ?? console, "report_status_transition", {
      jobId: next.id,
      assignmentId: next.assignmentId,
      fromStatus,
      toStatus: status,
    });
  }
  return next;
}

async function appendEvent(id: string, message: string): Promise<ReportJob> {
  const { jobs } = createStores();
  return jobs.mutate(id, (job) => {
    const last = job.events[job.events.length - 1]?.message;
    if (last === message) return job;
    return {
      ...job,
      events: [...job.events, { at: new Date().toISOString(), message }],
    };
  });
}

async function markJobFailed(
  id: string,
  errorMessage: string,
  logger: ReportObservabilityLogger = console,
): Promise<ReportJob | undefined> {
  try {
    const current = await getReport(id);
    if (!current) return undefined;
    if (isTerminalReportStatus(current.status) || current.status === "awaiting_review") return current;
    return await transitionReportJob(id, "failed", {
      logger,
      patch: {
        errorMessage,
        userFacingMessage: formatJobErrorForUser(errorMessage),
      },
    });
  } catch (failureUpdateError) {
    console.error("Could not mark report job as failed.", {
      jobId: id,
      error: failureUpdateError instanceof Error ? failureUpdateError.message : String(failureUpdateError),
    });
    return undefined;
  }
}

function appendReportEvents(events: ReportJob["events"], messages: readonly string[]): ReportJob["events"] {
  const next = [...events];
  for (const message of messages) {
    if (!message) continue;
    const last = next[next.length - 1]?.message;
    if (last === message) continue;
    next.push({ at: new Date().toISOString(), message });
  }
  return next;
}

async function notifyUpdate(job: ReportJob, onUpdate?: ReportJobUpdateSink): Promise<void> {
  await onUpdate?.(job);
}

async function prepareAddressForReport(address: AddressCandidate): Promise<AddressCandidate> {
  try {
    return await enrichAddressCandidateCoordinates(address);
  } catch (error) {
    console.warn("Could not enrich report address geometry.", {
      candidateId: address.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return address;
  }
}

async function ensureAssignmentLinkable(options: CreateReportOptions): Promise<void> {
  if (!options.assignmentId) return;
  if (!options.ownerClientId) {
    throw new Error("ownerClientId is required when assignmentId is provided.");
  }
  const assignment = await getAssignmentForOwner(options.assignmentId, options.ownerClientId);
  if (!assignment) {
    throw new AssignmentNotFoundError(options.assignmentId);
  }
}

async function linkAssignmentToJob(job: ReportJob, options: CreateReportOptions): Promise<void> {
  if (!options.assignmentId || !options.ownerClientId) return;
  try {
    await linkAssignmentReportJob(options.assignmentId, options.ownerClientId, job.id);
  } catch (error) {
    console.error("Could not link report job to assignment.", {
      jobId: job.id,
      assignmentId: options.assignmentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function mirrorAssignmentStatusForJob(
  job: ReportJob,
  status: "running" | "awaiting_review" | "complete" | "rejected" | "failed",
  logger: ReportObservabilityLogger = console,
): Promise<void> {
  try {
    if (!job?.assignmentId) return;
    await applyAssignmentReportStatus(job.assignmentId, status);
  } catch (error) {
    logger.error("Could not mirror assignment status.", {
      jobId: job.id,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function recordVaultArtifactsForJob(
  job: ReportJob,
  logger: ReportObservabilityLogger = console,
): Promise<void> {
  if (!job.assignmentId) return;
  const { assignments } = createStores();
  const assignment = await assignments.get(job.assignmentId);
  if (!assignment) return;

  const artifacts: ReportArtifactInput[] = [];
  if (job.markdownArtifactKey) {
    artifacts.push({
      kind: "report_markdown",
      artifactKey: job.markdownArtifactKey,
      contentType: "text/markdown; charset=utf-8",
      filename: `${job.id}.md`,
    });
  }
  if (job.pdfArtifactKey) {
    artifacts.push({
      kind: "report_pdf",
      artifactKey: job.pdfArtifactKey,
      contentType: "application/pdf",
      filename: `${job.id}.pdf`,
    });
  }
  if (job.canonicalArtifactKey) {
    artifacts.push({
      kind: "report_canonical_json",
      artifactKey: job.canonicalArtifactKey,
      contentType: CANONICAL_CONTENT_TYPE,
      filename: `${job.id}.canonical.json`,
    });
  }
  if (artifacts.length === 0) return;

  try {
    const recorded = await recordReportArtifacts({
      assignmentId: job.assignmentId,
      ownerClientId: assignment.ownerClientId,
      jobId: job.id,
      artifacts,
    });
    for (const item of recorded) {
      emitReportEvent(logger, "report_vault_record_created", {
        jobId: job.id,
        assignmentId: job.assignmentId,
        artifactKind: item.kind,
      });
    }
  } catch (error) {
    logger.error("Could not record report artifacts in Vault.", {
      jobId: job.id,
      assignmentId: job.assignmentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function recordMcpToolCallEvidenceForJob(
  job: ReportJob,
  toolCalls: ReadonlyArray<McpToolCallRecord>,
): Promise<VaultItem[]> {
  if (!job.assignmentId || toolCalls.length === 0) return [];
  const { assignments } = createStores();
  const assignment = await assignments.get(job.assignmentId);
  if (!assignment) return [];

  try {
    return await recordMcpToolCallEvidence({
      assignmentId: job.assignmentId,
      ownerClientId: assignment.ownerClientId,
      jobId: job.id,
      toolCalls,
    });
  } catch (error) {
    console.error("Could not record MCP tool-call evidence in Vault.", {
      jobId: job.id,
      assignmentId: job.assignmentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function collectUploadedVaultDocsForJob(job: ReportJob): Promise<UploadedVaultDoc[] | undefined> {
  if (!job.assignmentId) return undefined;
  const items = await listVaultItemsForAssignment(job.ownerClientId, job.assignmentId);
  const docs = pickUploadedVaultDocsForPrompt(items);
  return docs.length > 0 ? docs : undefined;
}

function sanitizeProgressMessage(message: string): string {
  const redacted = message
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
  return formatProgressMessageForUser(redacted).slice(0, 260);
}

export function formatProgressMessageForUser(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return "Report agent is working.";

  if (/^read$/i.test(normalized)) return "Reading datasource guidance.";
  if (/^bash$/i.test(normalized)) return "Running report workspace check.";
  if (/^write$/i.test(normalized)) return "Writing report file.";
  if (/^edit$/i.test(normalized)) return "Updating report file.";
  if (/^(grep|rg)$/i.test(normalized)) return "Checking report notes.";
  if (/^view$/i.test(normalized)) return "Reviewing collected report context.";
  if (/^tool result$/i.test(normalized)) return "Datasource response received.";
  if (/^tool call/i.test(normalized)) return "Querying a datasource.";
  if (/^custom tool result accepted/i.test(normalized)) return "Datasource response accepted.";
  if (/unable to open database|sql\/session\.db|session database/i.test(normalized)) {
    return "Report workspace lookup was unavailable; continuing with datasource context.";
  }
  if (/only seeing the bounded context/i.test(normalized)) return "Datasource facts are limited; adjusting lookup strategy.";
  if (/services search isn't returning results/i.test(normalized)) return "Datasource service search was limited; drafting report with collected evidence.";

  const lower = normalized.toLowerCase();
  const saved = /ingested into sql/i.test(normalized);
  const diagnostic = /diagnostic recorded/i.test(normalized);

  if (lower.includes("dataforsyningen") && lower.includes("search_address_or_place")) {
    return saved
      ? "Dataforsyningen address results saved for report generation."
      : diagnostic
        ? "Dataforsyningen address lookup returned a diagnostic."
        : "Searching Dataforsyningen for the confirmed address.";
  }

  if (lower.includes("dataforsyningen") && lower.includes("search_services")) {
    return saved ? "Dataforsyningen service catalogue results saved." : "Checking Dataforsyningen service coverage.";
  }

  if (lower.includes("datafordeler") && lower.includes("resolve_property")) {
    return saved
      ? "Datafordeler property match saved for report generation."
      : "Resolving public property identifiers in Datafordeler.";
  }

  if (lower.includes("datafordeler") && lower.includes("get_property_context")) {
    return saved
      ? "Datafordeler property context saved for report generation."
      : "Collecting public property context from Datafordeler.";
  }

  if (lower.includes("datafordeler") && lower.includes("property_get_graph")) {
    return saved
      ? "Datafordeler property graph saved for report generation."
      : "Collecting public property graph from Datafordeler.";
  }

  if (lower.includes("datafordeler") && lower.includes("property_get_buildings")) {
    return diagnostic ? "Building lookup returned a datasource diagnostic." : "Checking public building records.";
  }

  if (lower.includes("datafordeler") && lower.includes("property_get_units")) {
    return diagnostic ? "Unit lookup returned a datasource diagnostic." : "Checking public unit records.";
  }

  if (lower.includes("datafordeler") && lower.includes("property_get_parcels")) {
    return diagnostic ? "Parcel lookup returned a datasource diagnostic." : "Checking public parcel records.";
  }

  if (lower.includes("datafordeler") && lower.includes("get_source_records")) {
    return saved ? "Datafordeler source records saved for report generation." : "Checking source register records.";
  }

  if (lower.includes("plandata") && lower.includes("coverage_status")) {
    return saved ? "Plandata coverage status saved." : "Checking Plandata coverage.";
  }

  if (lower.includes("plandata") && lower.includes("list_layers")) {
    return saved ? "Plandata layer catalogue saved." : "Checking available planning layers.";
  }

  if (lower.includes("plandata") && lower.includes("query_layer")) {
    return diagnostic ? "Planning layer lookup returned a datasource diagnostic." : "Querying planning layers.";
  }

  if (lower.includes("plandata") && lower.includes("find_plans_by_geometry")) {
    return diagnostic ? "Planning geometry lookup returned a datasource diagnostic." : "Finding public plans near the address.";
  }

  if (lower.includes("plandata")) {
    return saved ? "Planning datasource result saved for report generation." : "Collecting public planning context.";
  }

  if (saved) return "Datasource result saved for report generation.";
  if (diagnostic) return "Datasource diagnostic recorded.";

  return normalized;
}

function filenameStem(address: string): string {
  return address
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "address";
}
