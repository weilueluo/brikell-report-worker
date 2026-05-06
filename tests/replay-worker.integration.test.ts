import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressCandidate } from "@brikell/shared";
import { createReport, getReport } from "../src/reports/report-service";
import { runReportWorkerOnce } from "../src/reports/report-worker";
import { withSupabaseTestContext } from "./fixtures/supabase-context";
import { replayReportRunner } from "./fixtures/runners/replay-runner";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_DIR = join(__dirname, "fixtures", "transcripts");

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

function candidate(): AddressCandidate {
  return {
    id: "addr-test-001",
    label: "Test Address 1, 1000 København",
    postalCode: "1000",
    city: "København",
    coordinateSource: "selected-candidate",
    source: { provider: "Dataforsyningen" },
  };
}

test("worker drives a queued job to awaiting_review when fed a basic-success transcript", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const ownerClientId = ctx.ownerClientId;
    const job = await createReport(candidate(), { ownerClientId });
    assert.equal(job.status, "queued");

    const result = await runReportWorkerOnce({
      workerId: ctx.uniqueId("worker"),
      heartbeatMs: 10,
      staleAfterMs: 60_000,
      logger: silentLogger(),
      runner: replayReportRunner({ path: join(FIXTURE_DIR, "basic-success.jsonl") }),
      ownerClientId,
    });

    assert.equal(result.kind, "processed");
    assert.equal(result.jobId, job.id);
    assert.equal(result.status, "awaiting_review");

    const finished = await getReport(job.id);
    assert.equal(finished?.status, "awaiting_review");
    assert.ok(finished?.markdownArtifactKey);
    assert.ok(finished?.canonicalArtifactKey);
  });
});

test("worker fails the job when the runner-error transcript ends without canonical output", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const ownerClientId = ctx.ownerClientId;
    const job = await createReport(candidate(), { ownerClientId });

    await runReportWorkerOnce({
      workerId: ctx.uniqueId("worker"),
      heartbeatMs: 10,
      staleAfterMs: 60_000,
      logger: silentLogger(),
      runner: replayReportRunner({ path: join(FIXTURE_DIR, "runner-error.jsonl") }),
      ownerClientId,
    });

    const finished = await getReport(job.id);
    assert.equal(finished?.status, "failed");
  });
});
