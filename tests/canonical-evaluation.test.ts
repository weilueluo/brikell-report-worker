import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeCanonicalOutcome,
  evaluateCanonical,
  summarizeCanonicalRequirementFailure,
  type CanonicalEvaluation,
} from "../src/reports/canonical-evaluation";
import {
  deltaParkV1Fixture,
} from "@brikell/shared";
import type { ReportV1 } from "@brikell/shared";

const ADDRESS = deltaParkV1Fixture.subject.inputAddress;

test("evaluateCanonical returns skipped with passed-through reason when canonicalReport is undefined", () => {
  const outcome = evaluateCanonical({
    expectedAddressLabel: ADDRESS,
    canonicalAbsentReason: "Mock runner did not emit canonical V1.",
  });

  assert.equal(outcome.kind, "skipped");
  if (outcome.kind === "skipped") {
    assert.equal(outcome.reason, "Mock runner did not emit canonical V1.");
  }
});

test("evaluateCanonical returns skipped with default reason when no reason is provided", () => {
  const outcome = evaluateCanonical({ expectedAddressLabel: ADDRESS });

  assert.equal(outcome.kind, "skipped");
  if (outcome.kind === "skipped") {
    assert.match(outcome.reason, /not produced/i);
  }
});

test("evaluateCanonical returns subject_mismatch when canonical subject differs from expected address", () => {
  const outcome = evaluateCanonical({
    expectedAddressLabel: "Other Street 1, 1234 Other City",
    canonicalReport: deltaParkV1Fixture,
  });

  assert.equal(outcome.kind, "subject_mismatch");
  if (outcome.kind === "subject_mismatch") {
    assert.equal(outcome.expected, "Other Street 1, 1234 Other City");
    assert.equal(outcome.actual, ADDRESS);
  }
});

test("evaluateCanonical returns rendered with non-empty Markdown and parseable JSON for valid report", () => {
  const outcome = evaluateCanonical({
    expectedAddressLabel: ADDRESS,
    canonicalReport: deltaParkV1Fixture,
  });

  assert.equal(outcome.kind, "rendered");
  if (outcome.kind === "rendered") {
    assert.ok(outcome.markdown.length > 0);
    assert.match(outcome.markdown, /Delta Park/);
    const parsed = JSON.parse(outcome.json) as ReportV1;
    assert.equal(parsed.schemaVersion, "v1");
    assert.equal(parsed.subject.inputAddress, ADDRESS);
  }
});

test("evaluateCanonical returns render_failed when renderer throws on a malformed report", () => {
  const broken = {
    ...deltaParkV1Fixture,
    sections: undefined as unknown,
  } as unknown as ReportV1;

  const outcome = evaluateCanonical({
    expectedAddressLabel: ADDRESS,
    canonicalReport: broken,
  });

  assert.equal(outcome.kind, "render_failed");
  if (outcome.kind === "render_failed") {
    assert.ok(outcome.reason.length > 0);
  }
});

test("describeCanonicalOutcome produces a deterministic event message for each kind", () => {
  const cases: CanonicalEvaluation[] = [
    { kind: "rendered", markdown: "x", json: "{}" },
    { kind: "skipped", reason: "absent for testing" },
    { kind: "subject_mismatch", expected: "A", actual: "B" },
    { kind: "render_failed", reason: "boom" },
  ];

  const messages = cases.map(describeCanonicalOutcome);
  assert.match(messages[0], /Rendered facts-first/);
  assert.match(messages[1], /not available/i);
  assert.match(messages[1], /absent for testing/);
  assert.match(messages[2], /did not match/);
  assert.match(messages[2], /"A"/);
  assert.match(messages[2], /"B"/);
  assert.match(messages[3], /rendering failed/i);
  assert.match(messages[3], /boom/);
});

test("summarizeCanonicalRequirementFailure produces actionable error messages for require-canonical mode", () => {
  assert.match(
    summarizeCanonicalRequirementFailure({ kind: "skipped", reason: "absent reason" }),
    /required.*not produced.*absent reason/i,
  );
  assert.match(
    summarizeCanonicalRequirementFailure({
      kind: "subject_mismatch",
      expected: "X",
      actual: "Y",
    }),
    /required.*subject.*X.*Y/,
  );
  assert.match(
    summarizeCanonicalRequirementFailure({ kind: "render_failed", reason: "kaboom" }),
    /required.*failed to render.*kaboom/i,
  );
  assert.match(
    summarizeCanonicalRequirementFailure({ kind: "rendered", markdown: "x", json: "{}" }),
    /produced/i,
  );
});
