import { createErrorDiagnostic, type ErrorDiagnostic } from "@brikell/shared";

export type ReportObservabilityLogger = Pick<Console, "error" | "log" | "warn">;
export type ReportObservabilityLevel = keyof ReportObservabilityLogger;

export const reportObservabilityEventNames = [
  "report_job_created",
  "report_active_job_conflict",
  "report_status_transition",
  "report_runner_no_artifact_failed",
  "report_artifact_persisted",
  "report_vault_record_created",
  "report_review_approved",
  "report_review_rejected",
  "report_review_invalid_transition",
  "report_draft_download_served",
  "report_final_download_served",
  "report_download_denied",
  "report_owner_access_denied",
  "report_worker_claimed_job",
  "report_worker_heartbeat_error",
  "report_worker_finished_job",
] as const;

export type ReportObservabilityEventName = (typeof reportObservabilityEventNames)[number];

export type ReportObservabilityPayload = {
  jobId?: string;
  assignmentId?: string;
  fromStatus?: string;
  toStatus?: string;
  status?: string;
  workerId?: string;
  reviewAction?: "approve" | "reject";
  conflictReason?: string;
  warningCode?: string;
  errorCode?: string;
  route?: string;
  action?: string;
  reason?: string;
  artifactKind?: string;
  format?: string;
  attempt?: number;
  staleFailed?: number;
  error?: unknown;
};

export type ReportObservabilityEmittedPayload = Omit<ReportObservabilityPayload, "error"> & {
  event: ReportObservabilityEventName;
  error?: ErrorDiagnostic;
};

type ReportObservabilityEventContract = {
  required: readonly (keyof ReportObservabilityEmittedPayload)[];
  denied: readonly string[];
};

const deniedSensitiveFields = [
  "authorization",
  "content",
  "cookie",
  "cookies",
  "documentText",
  "markdown",
  "note",
  "rawDocumentText",
  "rawRequestBody",
  "reportContent",
  "requestBody",
  "reviewerNote",
  "secret",
  "text",
  "token",
] as const;

export const reportObservabilityEventContracts: Record<
  ReportObservabilityEventName,
  ReportObservabilityEventContract
> = {
  report_job_created: { required: ["event", "jobId", "status"], denied: deniedSensitiveFields },
  report_active_job_conflict: { required: ["event", "assignmentId", "conflictReason"], denied: deniedSensitiveFields },
  report_status_transition: { required: ["event", "jobId", "fromStatus", "toStatus"], denied: deniedSensitiveFields },
  report_runner_no_artifact_failed: { required: ["event", "jobId", "warningCode"], denied: deniedSensitiveFields },
  report_artifact_persisted: { required: ["event", "jobId", "artifactKind"], denied: deniedSensitiveFields },
  report_vault_record_created: { required: ["event", "jobId", "artifactKind"], denied: deniedSensitiveFields },
  report_review_approved: { required: ["event", "jobId", "reviewAction"], denied: deniedSensitiveFields },
  report_review_rejected: { required: ["event", "jobId", "reviewAction"], denied: deniedSensitiveFields },
  report_review_invalid_transition: {
    required: ["event", "jobId", "fromStatus", "reviewAction"],
    denied: deniedSensitiveFields,
  },
  report_draft_download_served: { required: ["event", "jobId", "format"], denied: deniedSensitiveFields },
  report_final_download_served: { required: ["event", "jobId", "format"], denied: deniedSensitiveFields },
  report_download_denied: { required: ["event", "jobId", "reason"], denied: deniedSensitiveFields },
  report_owner_access_denied: { required: ["event", "route", "reason"], denied: deniedSensitiveFields },
  report_worker_claimed_job: { required: ["event", "jobId", "workerId"], denied: deniedSensitiveFields },
  report_worker_heartbeat_error: { required: ["event", "jobId", "workerId", "error"], denied: deniedSensitiveFields },
  report_worker_finished_job: { required: ["event", "jobId", "workerId", "status"], denied: deniedSensitiveFields },
};

const allowedPayloadFields = new Set<keyof ReportObservabilityPayload>([
  "action",
  "assignmentId",
  "artifactKind",
  "attempt",
  "conflictReason",
  "error",
  "errorCode",
  "format",
  "fromStatus",
  "jobId",
  "reason",
  "reviewAction",
  "route",
  "staleFailed",
  "status",
  "toStatus",
  "warningCode",
  "workerId",
]);

export function emitReportEvent(
  logger: ReportObservabilityLogger,
  event: ReportObservabilityEventName,
  payload: ReportObservabilityPayload,
  level: ReportObservabilityLevel = "log",
): ReportObservabilityEmittedPayload {
  const emitted = buildReportEventPayload(event, payload);
  assertReportEventPayload(event, emitted);
  logger[level]("Report event.", emitted);
  return emitted;
}

export function buildReportEventPayload(
  event: ReportObservabilityEventName,
  payload: ReportObservabilityPayload,
): ReportObservabilityEmittedPayload {
  const emitted: ReportObservabilityEmittedPayload = { event };
  for (const [key, value] of Object.entries(payload) as [keyof ReportObservabilityPayload, unknown][]) {
    if (value === undefined || !allowedPayloadFields.has(key)) continue;
    if (key === "error") {
      emitted.error = createErrorDiagnostic(value);
      continue;
    }
    (emitted as Record<string, unknown>)[key] = value;
  }
  return emitted;
}

export function assertReportEventPayload(
  event: ReportObservabilityEventName,
  payload: ReportObservabilityEmittedPayload,
): void {
  const contract = reportObservabilityEventContracts[event];
  for (const field of contract.required) {
    if (payload[field] === undefined) {
      throw new Error(`Report observability event ${event} is missing required field ${String(field)}.`);
    }
  }
  for (const field of contract.denied) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new Error(`Report observability event ${event} includes denied field ${field}.`);
    }
  }
}

