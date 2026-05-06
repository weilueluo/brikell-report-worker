import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractCanonicalReportFromOutputs } from "../src/agent/canonical-output";
import { buildFixtureCanonicalReport as buildMockCanonicalReport } from "./fixtures/runners/fixture-results";
import {
  managedReportCanonicalPath,
  managedReportMarkdownPath,
  safePathSegment,
} from "../src/agent/prompt";
import { validateReportV1 } from "@brikell/shared";
import type { AddressCandidate } from "@brikell/shared";

const ADDRESS: AddressCandidate = {
  id: "fixture-address",
  label: "Delta Park 10-22, 2665 Vallensbaek Strand",
  source: { provider: "Dataforsyningen", serviceId: "gsearch" },
};

test("safePathSegment sanitizes job IDs to filesystem-safe slugs", () => {
  assert.equal(safePathSegment("job/with/slash"), "job_with_slash");
  assert.equal(safePathSegment("../etc/passwd"), ".._etc_passwd");
  assert.equal(safePathSegment(""), "report");
  assert.equal(safePathSegment("normal-uuid_42.x"), "normal-uuid_42.x");
});

test("managed report paths share the same sanitized job directory", () => {
  const dirty = "job/with spaces and  weird@chars";
  const safe = safePathSegment(dirty);
  assert.equal(managedReportMarkdownPath(dirty), `/mnt/session/outputs/${safe}/report.md`);
  assert.equal(managedReportCanonicalPath(dirty), `/mnt/session/outputs/${safe}/report.json`);
});

test("buildMockCanonicalReport produces a payload that validates against the V1 schema", () => {
  const report = buildMockCanonicalReport("mock-job", ADDRESS, "2026-05-01T00:00:00.000Z");
  const result = validateReportV1(report);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.subject.inputAddress, ADDRESS.label);
  assert.equal(result.report.sections.kommuneplan.availability, "not_reviewed");
  assert.equal(result.report.sections.buildings.availability, "not_reviewed");
  assert.deepEqual(result.report.sourceDocuments, []);
});

test("extractCanonicalReportFromOutputs returns absent when expected path missing", async () => {
  const progress: string[] = [];
  const out = await extractCanonicalReportFromOutputs(
    [{ managedPath: "/mnt/session/outputs/other/report.json", content: "{}" }],
    "/mnt/session/outputs/expected/report.json",
    async (m) => { progress.push(m); },
  );
  assert.equal(out.kind, "absent");
  assert.deepEqual(progress, []);
});

test("extractCanonicalReportFromOutputs returns parse_failed for non-JSON content", async () => {
  const progress: string[] = [];
  const out = await extractCanonicalReportFromOutputs(
    [{ managedPath: "/expected/report.json", content: "not json {{" }],
    "/expected/report.json",
    async (m) => { progress.push(m); },
  );
  assert.equal(out.kind, "parse_failed");
  assert.equal(progress.length, 1);
  assert.match(progress[0]!, /failed to parse/);
});

test("extractCanonicalReportFromOutputs returns validation_failed for non-conforming JSON", async () => {
  const progress: string[] = [];
  const out = await extractCanonicalReportFromOutputs(
    [{ managedPath: "/expected/report.json", content: JSON.stringify({ schemaVersion: "v1" }) }],
    "/expected/report.json",
    async (m) => { progress.push(m); },
  );
  assert.equal(out.kind, "validation_failed");
  assert.equal(progress.length, 1);
  assert.match(progress[0]!, /failed validation/);
});

test("extractCanonicalReportFromOutputs returns found for valid V1 JSON via inline content", async () => {
  const valid = buildMockCanonicalReport("job-x", ADDRESS, "2026-05-01T00:00:00.000Z");
  const out = await extractCanonicalReportFromOutputs(
    [{ managedPath: "/expected/report.json", content: JSON.stringify(valid) }],
    "/expected/report.json",
  );
  assert.equal(out.kind, "found");
  if (out.kind !== "found") return;
  assert.equal(out.report.reportId, "job-x");
  assert.equal(out.report.subject.inputAddress, ADDRESS.label);
});

test("extractCanonicalReportFromOutputs uses the exact expected managed path", async () => {
  const wrongPathReport = buildMockCanonicalReport("wrong-job", ADDRESS, "2026-05-01T00:00:00.000Z");
  const expectedReport = buildMockCanonicalReport("expected-job", ADDRESS, "2026-05-01T00:00:00.000Z");
  const out = await extractCanonicalReportFromOutputs(
    [
      { managedPath: "/mnt/session/outputs/wrong/report.json", content: JSON.stringify(wrongPathReport) },
      { managedPath: "/mnt/session/outputs/expected/report.json", content: JSON.stringify(expectedReport) },
    ],
    "/mnt/session/outputs/expected/report.json",
  );

  assert.equal(out.kind, "found");
  if (out.kind !== "found") return;
  assert.equal(out.report.reportId, "expected-job");
});

test("extractCanonicalReportFromOutputs reads from localPath when content is empty", async () => {
  const valid = buildMockCanonicalReport("job-y", ADDRESS, "2026-05-01T00:00:00.000Z");
  const dir = await mkdtemp(join(tmpdir(), "brikell-runner-canonical-"));
  await mkdir(dir, { recursive: true });
  const localPath = join(dir, "report.json");
  await writeFile(localPath, JSON.stringify(valid), "utf8");

  const out = await extractCanonicalReportFromOutputs(
    [{ managedPath: "/expected/report.json", content: "", localPath }],
    "/expected/report.json",
  );
  assert.equal(out.kind, "found");
});

test("extractCanonicalReportFromOutputs prefers inline content over localPath", async () => {
  const valid = buildMockCanonicalReport("job-inline", ADDRESS, "2026-05-01T00:00:00.000Z");
  const dir = await mkdtemp(join(tmpdir(), "brikell-runner-canonical-"));
  await mkdir(dir, { recursive: true });
  const localPath = join(dir, "report.json");
  await writeFile(localPath, "not json", "utf8");

  const out = await extractCanonicalReportFromOutputs(
    [{ managedPath: "/expected/report.json", content: JSON.stringify(valid), localPath }],
    "/expected/report.json",
  );
  assert.equal(out.kind, "found");
  if (out.kind !== "found") return;
  assert.equal(out.report.reportId, "job-inline");
});

test("extractCanonicalReportFromOutputs returns unreadable for empty content without a localPath", async () => {
  const progress: string[] = [];
  const out = await extractCanonicalReportFromOutputs(
    [{ managedPath: "/expected/report.json", content: "" }],
    "/expected/report.json",
    async (m) => { progress.push(m); },
  );
  assert.equal(out.kind, "unreadable");
  assert.deepEqual(progress, ["Canonical V1 JSON file could not be read; falling back to Markdown."]);
});

test("extractCanonicalReportFromOutputs returns unreadable when localPath is missing", async () => {
  const progress: string[] = [];
  const out = await extractCanonicalReportFromOutputs(
    [{ managedPath: "/expected/report.json", content: "", localPath: "/no/such/file/report.json" }],
    "/expected/report.json",
    async (m) => { progress.push(m); },
  );
  assert.equal(out.kind, "unreadable");
  assert.equal(progress.length, 1);
  assert.match(progress[0]!, /could not be read/);
});
