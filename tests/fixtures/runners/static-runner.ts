import type { ManagedRunnerResult, ReportRunner } from "../../../src/agent/runner-client";

/**
 * Hardcoded `ReportRunner` for tests that exercise the worker job-state
 * machine where the agent's behaviour is irrelevant.
 *
 * - `ensureReady` is a no-op (production `ensureManagedSkillEnvironment` is
 *   never called).
 * - `run` returns the supplied `result` and emits the optional
 *   `progressMessages` through `onProgress` so that progress-recording paths
 *   are still exercised.
 *
 * Replaces the deleted `BRIKELL_REPORT_RUNNER_MODE=mock` env switch.
 */
export function staticReportRunner(
  result: ManagedRunnerResult,
  options: { progressMessages?: ReadonlyArray<string> } = {},
): ReportRunner {
  return {
    ensureReady: async () => {},
    run: async (_jobId, _address, onProgress) => {
      const progress = options.progressMessages ?? ["Starting managed report runner."];
      for (const message of progress) {
        await onProgress?.(message);
      }
      return result;
    },
  };
}

/**
 * `ReportRunner` whose `ensureReady` (or `run`) throws. Useful for testing
 * worker error paths.
 */
export function failingReportRunner(
  error: Error,
  options: { failOn?: "ensureReady" | "run" } = {},
): ReportRunner {
  const failOn = options.failOn ?? "run";
  return {
    ensureReady: async () => {
      if (failOn === "ensureReady") throw error;
    },
    run: async () => {
      if (failOn === "run") throw error;
      return { mcpCollectionEvidence: [] };
    },
  };
}
