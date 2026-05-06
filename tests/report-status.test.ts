import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportStatus } from "@brikell/shared";
import {
  REPORT_STATUS_VIEW,
  getReportStatusView,
  isActiveReportStatus,
  isFailedOrRejectedReportStatus,
  isFinalDownloadableReportStatus,
  isPollingReportStatus,
  isReviewableReportStatus,
  isTerminalReportStatus,
} from "../src/reports/report-status";

const ALL: ReportStatus[] = [
  "queued",
  "running",
  "rendering_pdf",
  "awaiting_review",
  "complete",
  "rejected",
  "failed",
];

test("REPORT_STATUS_VIEW has a stable shape for every report status", () => {
  for (const status of ALL) {
    const view = REPORT_STATUS_VIEW[status];
    assert.equal(view.status, status);
    assert.ok(view.label.length > 0, `${status} has a label`);
    assert.ok(view.description.length > 0, `${status} has a description`);
    assert.ok(view.stage.length > 0, `${status} has a stage`);
  }
});

test("getReportStatusView returns the expected stage classification per status", () => {
  assert.equal(getReportStatusView("queued").stage, "processing");
  assert.equal(getReportStatusView("running").stage, "ai_analysis");
  assert.equal(getReportStatusView("rendering_pdf").stage, "preparing_report");
  assert.equal(getReportStatusView("awaiting_review").stage, "human_review");
  assert.equal(getReportStatusView("complete").stage, "done");
  assert.equal(getReportStatusView("rejected").stage, "changes_requested");
  assert.equal(getReportStatusView("failed").stage, "failed");
});

test("isActiveReportStatus marks queued, running, rendering_pdf, awaiting_review", () => {
  assert.equal(isActiveReportStatus("queued"), true);
  assert.equal(isActiveReportStatus("running"), true);
  assert.equal(isActiveReportStatus("rendering_pdf"), true);
  assert.equal(isActiveReportStatus("awaiting_review"), true);
  assert.equal(isActiveReportStatus("complete"), false);
  assert.equal(isActiveReportStatus("rejected"), false);
  assert.equal(isActiveReportStatus("failed"), false);
});

test("isPollingReportStatus marks the statuses the UI should keep polling", () => {
  assert.equal(isPollingReportStatus("queued"), true);
  assert.equal(isPollingReportStatus("running"), true);
  assert.equal(isPollingReportStatus("rendering_pdf"), true);
  // awaiting_review is reviewable, not polling
  assert.equal(isPollingReportStatus("awaiting_review"), false);
  assert.equal(isPollingReportStatus("complete"), false);
});

test("isReviewableReportStatus is true only for awaiting_review", () => {
  for (const status of ALL) {
    assert.equal(isReviewableReportStatus(status), status === "awaiting_review");
  }
});

test("isFinalDownloadableReportStatus is true only for complete", () => {
  for (const status of ALL) {
    assert.equal(isFinalDownloadableReportStatus(status), status === "complete");
  }
});

test("isTerminalReportStatus marks complete, rejected, failed", () => {
  assert.equal(isTerminalReportStatus("complete"), true);
  assert.equal(isTerminalReportStatus("rejected"), true);
  assert.equal(isTerminalReportStatus("failed"), true);
  assert.equal(isTerminalReportStatus("queued"), false);
  assert.equal(isTerminalReportStatus("running"), false);
  assert.equal(isTerminalReportStatus("rendering_pdf"), false);
  assert.equal(isTerminalReportStatus("awaiting_review"), false);
});

test("isFailedOrRejectedReportStatus marks failed and rejected only", () => {
  for (const status of ALL) {
    assert.equal(
      isFailedOrRejectedReportStatus(status),
      status === "failed" || status === "rejected",
    );
  }
});
