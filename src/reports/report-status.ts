import type { ReportStatus } from "@brikell/shared";
export {
  ACTIVE_REPORT_STATUSES,
  POLLING_REPORT_STATUSES,
  REVIEWABLE_REPORT_STATUSES,
  FINAL_DOWNLOADABLE_REPORT_STATUSES,
  TERMINAL_REPORT_STATUSES,
  FAILED_OR_REJECTED_REPORT_STATUSES,
} from "@brikell/shared";
import {
  ACTIVE_REPORT_STATUSES,
  POLLING_REPORT_STATUSES,
  REVIEWABLE_REPORT_STATUSES,
  FINAL_DOWNLOADABLE_REPORT_STATUSES,
  TERMINAL_REPORT_STATUSES,
  FAILED_OR_REJECTED_REPORT_STATUSES,
} from "@brikell/shared";

export type ReportStatusStage =
  | "processing"
  | "ai_analysis"
  | "preparing_report"
  | "human_review"
  | "done"
  | "changes_requested"
  | "failed";

export type ReportStatusView = {
  status: ReportStatus;
  stage: ReportStatusStage;
  label: string;
  description: string;
};

export const REPORT_STATUS_VIEW: Record<ReportStatus, ReportStatusView> = {
  queued: {
    status: "queued",
    stage: "processing",
    label: "Processing",
    description: "Report request queued.",
  },
  running: {
    status: "running",
    stage: "ai_analysis",
    label: "AI analysis",
    description: "The report agent is collecting and analyzing source material.",
  },
  rendering_pdf: {
    status: "rendering_pdf",
    stage: "preparing_report",
    label: "Preparing report",
    description: "The report content is ready and artifacts are being prepared.",
  },
  awaiting_review: {
    status: "awaiting_review",
    stage: "human_review",
    label: "Awaiting human review",
    description: "A human reviewer must approve the generated report before it is done.",
  },
  complete: {
    status: "complete",
    stage: "done",
    label: "Done",
    description: "The report has been approved and final downloads are ready.",
  },
  rejected: {
    status: "rejected",
    stage: "changes_requested",
    label: "Changes requested",
    description: "A reviewer rejected this report run.",
  },
  failed: {
    status: "failed",
    stage: "failed",
    label: "Failed",
    description: "Report generation failed.",
  },
};

export function getReportStatusView(status: ReportStatus): ReportStatusView {
  return REPORT_STATUS_VIEW[status];
}

export function isActiveReportStatus(status: ReportStatus): boolean {
  return includesStatus(ACTIVE_REPORT_STATUSES, status);
}

export function isPollingReportStatus(status: ReportStatus): boolean {
  return includesStatus(POLLING_REPORT_STATUSES, status);
}

export function isReviewableReportStatus(status: ReportStatus): boolean {
  return includesStatus(REVIEWABLE_REPORT_STATUSES, status);
}

export function isFinalDownloadableReportStatus(status: ReportStatus): boolean {
  return includesStatus(FINAL_DOWNLOADABLE_REPORT_STATUSES, status);
}

export function isTerminalReportStatus(status: ReportStatus): boolean {
  return includesStatus(TERMINAL_REPORT_STATUSES, status);
}

export function isFailedOrRejectedReportStatus(status: ReportStatus): boolean {
  return includesStatus(FAILED_OR_REJECTED_REPORT_STATUSES, status);
}

function includesStatus(statuses: readonly ReportStatus[], status: ReportStatus): boolean {
  return statuses.includes(status);
}

