#!/usr/bin/env node
import { runReportWorker } from "./reports/report-worker";

const once = process.argv.includes("--once");
const controller = new AbortController();

function requestShutdown(signal: NodeJS.Signals): void {
  console.log("Report worker shutdown requested.", { signal });
  controller.abort();
}

process.once("SIGTERM", requestShutdown);
process.once("SIGINT", requestShutdown);

runReportWorker({ once, signal: controller.signal }).catch((error: unknown) => {
  console.error("Report worker failed.", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
