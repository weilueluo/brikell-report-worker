import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertReportEventPayload,
  buildReportEventPayload,
  emitReportEvent,
  reportObservabilityEventContracts,
  reportObservabilityEventNames,
  type ReportObservabilityEmittedPayload,
  type ReportObservabilityEventName,
  type ReportObservabilityLogger,
  type ReportObservabilityPayload,
} from "../src/reports/report-observability";

test("report observability contracts cover every event with required fields", () => {
  assert.deepEqual(Object.keys(reportObservabilityEventContracts).sort(), [...reportObservabilityEventNames].sort());

  for (const event of reportObservabilityEventNames) {
    const payload = buildReportEventPayload(event, minimumPayloadFor(event));
    assertReportEventPayload(event, payload);
    for (const field of reportObservabilityEventContracts[event].required) {
      assert.notEqual(payload[field], undefined, `${event} should include ${String(field)}`);
    }
  }
});

test("report observability payloads are allowlisted and redact errors", () => {
  const payload = {
    jobId: "job-observe",
    fromStatus: "queued",
    toStatus: "running",
    content: "full report text",
    cookies: "session=value",
    token: "secret-token",
    reviewerNote: "private note",
    rawRequestBody: "{secret:true}",
    error: new Error("failed with token=abc123"),
  } satisfies ReportObservabilityPayload & Record<string, unknown>;

  const emitted = buildReportEventPayload("report_status_transition", payload);
  assert.equal((emitted as Record<string, unknown>).content, undefined);
  assert.equal((emitted as Record<string, unknown>).cookies, undefined);
  assert.equal((emitted as Record<string, unknown>).token, undefined);
  assert.equal((emitted as Record<string, unknown>).reviewerNote, undefined);
  assert.equal((emitted as Record<string, unknown>).rawRequestBody, undefined);
  assert.match(emitted.error?.message ?? "", /token=\[redacted\]/);
});

test("emitReportEvent logs a validated structured event", () => {
  const records: ReportObservabilityEmittedPayload[] = [];
  const logger: ReportObservabilityLogger = {
    error: (_message, payload) => records.push(payload as ReportObservabilityEmittedPayload),
    log: (_message, payload) => records.push(payload as ReportObservabilityEmittedPayload),
    warn: (_message, payload) => records.push(payload as ReportObservabilityEmittedPayload),
  };

  const emitted = emitReportEvent(logger, "report_active_job_conflict", {
    assignmentId: "assignment-1",
    conflictReason: "active_report_exists",
  });

  assert.deepEqual(records, [emitted]);
  assert.equal(records[0].event, "report_active_job_conflict");
});

test("missing required observability fields fail loudly", () => {
  assert.throws(
    () => buildAndAssert("report_status_transition", { jobId: "job-missing", fromStatus: "queued" }),
    /missing required field toStatus/i,
  );
});

function buildAndAssert(event: ReportObservabilityEventName, payload: ReportObservabilityPayload): void {
  assertReportEventPayload(event, buildReportEventPayload(event, payload));
}

function minimumPayloadFor(event: ReportObservabilityEventName): ReportObservabilityPayload {
  switch (event) {
    case "report_job_created":
      return { jobId: "job-1", status: "queued" };
    case "report_active_job_conflict":
      return { assignmentId: "assignment-1", conflictReason: "active_report_exists" };
    case "report_status_transition":
      return { jobId: "job-1", fromStatus: "queued", toStatus: "running" };
    case "report_runner_no_artifact_failed":
      return { jobId: "job-1", warningCode: "no_artifact_submitted" };
    case "report_artifact_persisted":
    case "report_vault_record_created":
      return { jobId: "job-1", artifactKind: "markdown" };
    case "report_review_approved":
      return { jobId: "job-1", reviewAction: "approve" };
    case "report_review_rejected":
      return { jobId: "job-1", reviewAction: "reject" };
    case "report_review_invalid_transition":
      return { jobId: "job-1", fromStatus: "running", reviewAction: "approve" };
    case "report_draft_download_served":
    case "report_final_download_served":
      return { jobId: "job-1", format: "pdf" };
    case "report_download_denied":
      return { jobId: "job-1", reason: "not_complete" };
    case "report_owner_access_denied":
      return { route: "/api/reports/job-1", reason: "owner_mismatch" };
    case "report_worker_claimed_job":
      return { jobId: "job-1", workerId: "worker-1" };
    case "report_worker_heartbeat_error":
      return { jobId: "job-1", workerId: "worker-1", error: new Error("heartbeat failed") };
    case "report_worker_finished_job":
      return { jobId: "job-1", workerId: "worker-1", status: "awaiting_review" };
  }
}

