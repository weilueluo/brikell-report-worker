import { renderReportV1Markdown, type ReportV1 } from "@brikell/shared";

export type CanonicalEvaluation =
  | { kind: "rendered"; markdown: string; json: string }
  | { kind: "skipped"; reason: string }
  | { kind: "subject_mismatch"; expected: string; actual: string }
  | { kind: "render_failed"; reason: string };

export interface CanonicalEvaluationInput {
  readonly canonicalReport?: ReportV1;
  readonly canonicalAbsentReason?: string;
  readonly expectedAddressLabel: string;
}

const DEFAULT_SKIPPED_REASON = "Canonical V1 output not produced.";

export function evaluateCanonical(input: CanonicalEvaluationInput): CanonicalEvaluation {
  if (!input.canonicalReport) {
    return {
      kind: "skipped",
      reason: input.canonicalAbsentReason ?? DEFAULT_SKIPPED_REASON,
    };
  }

  const actual = input.canonicalReport.subject.inputAddress;
  if (actual !== input.expectedAddressLabel) {
    return { kind: "subject_mismatch", expected: input.expectedAddressLabel, actual };
  }

  try {
    const markdown = renderReportV1Markdown(input.canonicalReport);
    const json = JSON.stringify(input.canonicalReport, null, 2);
    return { kind: "rendered", markdown, json };
  } catch (error) {
    return {
      kind: "render_failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function describeCanonicalOutcome(outcome: CanonicalEvaluation): string {
  switch (outcome.kind) {
    case "rendered":
      return "Rendered facts-first report from canonical V1 output.";
    case "skipped":
      return `Canonical V1 output not available; using runner Markdown directly. Reason: ${outcome.reason}`;
    case "subject_mismatch":
      return `Canonical V1 report subject did not match the requested address (expected "${outcome.expected}", got "${outcome.actual}"); falling back to runner Markdown.`;
    case "render_failed":
      return `Canonical V1 rendering failed; falling back to runner Markdown. Reason: ${outcome.reason}`;
  }
}

export function summarizeCanonicalRequirementFailure(outcome: CanonicalEvaluation): string {
  switch (outcome.kind) {
    case "rendered":
      return "Canonical V1 report was produced.";
    case "skipped":
      return `Canonical V1 report was required but not produced: ${outcome.reason}`;
    case "subject_mismatch":
      return `Canonical V1 report was required but its subject did not match the requested address (expected "${outcome.expected}", got "${outcome.actual}").`;
    case "render_failed":
      return `Canonical V1 report was required but failed to render: ${outcome.reason}`;
  }
}
