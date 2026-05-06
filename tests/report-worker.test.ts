import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressCandidate } from "@brikell/shared";
import { createInitialJob } from "@brikell/shared";
import { createReport, getReport } from "../src/reports/report-service";
import {
  readReportWorkerConfig,
  runReportWorker,
  runReportWorkerOnce,
} from "../src/reports/report-worker";
import { createStores } from "../src/storage";
import { withSupabaseTestContext } from "./fixtures/supabase-context";
import { staticReportRunner } from "./fixtures/runners/static-runner";
import { buildFixtureMarkdownRunnerResult } from "./fixtures/runners/fixture-results";

test("report worker claims a queued job and leaves it awaiting review", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const ownerClientId = ctx.ownerClientId;
    const job = await createReport(candidate(), { ownerClientId });
    assert.equal(job.status, "queued");

    const result = await runReportWorkerOnce({
      workerId: ctx.uniqueId("worker"),
      heartbeatMs: 10,
      staleAfterMs: 60_000,
      logger: silentLogger(),
      runner: staticReportRunner(buildFixtureMarkdownRunnerResult(job.id, candidate())),
      ownerClientId,
    });

    assert.equal(result.kind, "processed");
    assert.equal(result.jobId, job.id);
    assert.equal(result.status, "awaiting_review");

    const reviewReady = await getReport(job.id);
    assert.equal(reviewReady?.status, "awaiting_review");
    assert.ok(reviewReady?.worker?.id);
    assert.ok(reviewReady?.markdownArtifactKey);
    assert.ok(reviewReady?.pdfArtifactKey);
  });
});

test("report worker fails stale running jobs before claiming more work", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const ownerClientId = ctx.ownerClientId;
    const { jobs } = createStores();
    const stale = await jobs.create(
      createInitialJob({ id: ctx.uniqueId("job-stale"), address: candidate(), ownerClientId }),
    );
    await jobs.claimNextQueuedReportJob(ctx.uniqueId("worker-old"), {
      ownerClientId: stale.ownerClientId,
      now: "2026-04-29T00:00:00.000Z",
    });

    const result = await runReportWorkerOnce({
      workerId: ctx.uniqueId("worker"),
      staleAfterMs: 60_000,
      logger: silentLogger(),
      runner: staticReportRunner(buildFixtureMarkdownRunnerResult(stale.id, candidate())),
      ownerClientId,
    });

    assert.equal(result.kind, "idle");
    assert.equal(result.staleFailed, 1);
    const failed = await jobs.get(stale.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.userFacingMessage, "The report worker stopped responding. Please regenerate the report.");
  });
});

test("report worker returns idle when no jobs are queued", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const result = await runReportWorkerOnce({
      workerId: ctx.uniqueId("worker"),
      staleAfterMs: 60_000,
      logger: silentLogger(),
      runner: staticReportRunner(buildFixtureMarkdownRunnerResult("ignored", candidate())),
      ownerClientId: ctx.ownerClientId,
    });

    assert.equal(result.kind, "idle");
    assert.equal(result.staleFailed, 0);
  });
});

test("readReportWorkerConfig honors overrides and falls back to env defaults", async () => {
  const config = readReportWorkerConfig({
    workerId: "worker-override",
    pollMs: 11,
    heartbeatMs: 22,
    staleAfterMs: 33,
    concurrency: 1,
  });
  assert.equal(config.workerId, "worker-override");
  assert.equal(config.pollMs, 11);
  assert.equal(config.heartbeatMs, 22);
  assert.equal(config.staleAfterMs, 33);
  assert.equal(config.concurrency, 1);

  // No overrides => env defaults are populated and concurrency must be 1.
  const defaults = readReportWorkerConfig();
  assert.equal(typeof defaults.workerId, "string");
  assert.ok(defaults.workerId.length > 0);
  assert.equal(typeof defaults.pollMs, "number");
  assert.equal(typeof defaults.heartbeatMs, "number");
  assert.equal(typeof defaults.staleAfterMs, "number");
  assert.equal(defaults.concurrency, 1);
});

test("runReportWorkerOnce rejects when concurrency is not exactly 1", async () => {
  await assert.rejects(
    () => runReportWorkerOnce({ concurrency: 2, logger: silentLogger() }),
    /BRIKELL_REPORT_WORKER_CONCURRENCY must be 1/,
  );
});

test("runReportWorker (loop) rejects when concurrency is not exactly 1", async () => {
  await assert.rejects(
    () => runReportWorker({ concurrency: 4, logger: silentLogger(), once: true }),
    /BRIKELL_REPORT_WORKER_CONCURRENCY must be 1/,
  );
});

test("runReportWorker with once:true loops a single iteration and returns when no work is queued", async () => {
  await withSupabaseTestContext(async (ctx) => {
    await runReportWorker({
      workerId: ctx.uniqueId("worker"),
      staleAfterMs: 60_000,
      logger: silentLogger(),
      once: true,
      runner: staticReportRunner(buildFixtureMarkdownRunnerResult("ignored", candidate())),
      ownerClientId: ctx.ownerClientId,
    });
  });
});

test("runReportWorker with once:true processes a queued job and exits", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const ownerClientId = ctx.ownerClientId;
    const job = await createReport(candidate(), { ownerClientId });
    assert.equal(job.status, "queued");

    await runReportWorker({
      workerId: ctx.uniqueId("worker"),
      staleAfterMs: 60_000,
      logger: silentLogger(),
      once: true,
      runner: staticReportRunner(buildFixtureMarkdownRunnerResult(job.id, candidate())),
      ownerClientId,
    });

    const reviewReady = await getReport(job.id);
    assert.equal(reviewReady?.status, "awaiting_review");
  });
});

function silentLogger() {
  return {
    log() {},
    warn() {},
    error() {},
  };
}

function candidate(): AddressCandidate {
  return {
    id: "fredericiagade-8",
    label: "Fredericiagade 8, 7500 Holstebro",
    postalCode: "7500",
    city: "Holstebro",
    coordinates: { x: 570000, y: 6190000, srid: "EPSG:25832" },
    coordinateSource: "selected-candidate",
    source: { provider: "Dataforsyningen", serviceId: "gsearch" },
  };
}
