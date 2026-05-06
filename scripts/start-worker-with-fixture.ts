#!/usr/bin/env node
/**
 * Test-only worker entrypoint used by Playwright suites.
 *
 * Production deploys never reference this script. It exists so the e2e UI
 * smoke runs can spin up a real worker process that drains the queued jobs
 * and produces fixture artifacts without spending Anthropic dollars.
 *
 * The chosen runner is `staticReportRunner(...)`. When transcript replay
 * lands (Phase F4) this script swaps to `replayReportRunner` and reads
 * `BRIKELL_TEST_TRANSCRIPT` from the environment.
 */
import type { AddressCandidate } from "@brikell/shared";
import { runReportWorker } from "../src/reports/report-worker";
import { staticReportRunner } from "../tests/fixtures/runners/static-runner";
import { buildFixtureCanonicalRunnerResult } from "../tests/fixtures/runners/fixture-results";

const FALLBACK_ADDRESS: AddressCandidate = {
  id: "playwright-fixture-address",
  label: "Playwright Fixture Address, 0000 København",
  postalCode: "0000",
  city: "København",
  coordinateSource: "selected-candidate",
  source: { provider: "Dataforsyningen", serviceId: "test-fixture" },
};

const once = process.argv.includes("--once");
const controller = new AbortController();

function requestShutdown(signal: NodeJS.Signals): void {
  console.log("Report worker (e2e fixture) shutdown requested.", { signal });
  controller.abort();
}

process.once("SIGTERM", requestShutdown);
process.once("SIGINT", requestShutdown);

const runner = staticReportRunner(buildFixtureCanonicalRunnerResult("e2e-fixture", FALLBACK_ADDRESS));

runReportWorker({ once, signal: controller.signal, runner }).catch((error: unknown) => {
  console.error("Report worker (e2e fixture) failed.", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
