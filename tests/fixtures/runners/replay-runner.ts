import { readFile } from "node:fs/promises";
import { parseTranscript, type ParsedTranscript } from "@brikell/shared";
import type { ManagedRunnerResult, ReportRunner } from "../../../src/agent/runner-client";

/**
 * Replay a recorded transcript through `ReportRunner.run`.
 *
 * Transcripts are NDJSON files captured via
 * `scripts/record-agent-transcript.ts`. Each entry is replayed in order:
 *
 * - `progress` entries are forwarded to `onProgress(message)`
 * - `toolCall` entries are accumulated and surfaced in the final result's
 *   `mcpToolCalls` (already validated as post-stamping at parse time)
 * - `final` is the terminal `ManagedRunnerResult`
 *
 * `ensureReady` is a no-op so worker tests never trigger real
 * managed-skill bootstrapping.
 *
 * Pass `transcript` directly (already parsed) for tests that want to
 * mutate transcripts in-memory; or pass a `path` to lazily read+parse
 * from disk on first `run` invocation.
 */
export type ReplayReportRunnerInput =
  | { transcript: ParsedTranscript }
  | { path: string };

export function replayReportRunner(input: ReplayReportRunnerInput): ReportRunner {
  let cached: ParsedTranscript | undefined =
    "transcript" in input ? input.transcript : undefined;

  const loadTranscript = async (): Promise<ParsedTranscript> => {
    if (cached) return cached;
    if ("path" in input) {
      const text = await readFile(input.path, "utf8");
      cached = parseTranscript(text);
      return cached;
    }
    throw new Error("replayReportRunner: no transcript provided");
  };

  return {
    ensureReady: async () => {},
    run: async (_jobId, _address, onProgress) => {
      const transcript = await loadTranscript();
      for (const entry of transcript.entries) {
        if (entry.kind === "progress") {
          await onProgress?.(entry.message);
        }
      }
      const final = transcript.final;
      const result: ManagedRunnerResult = {
        markdown: final.markdown,
        canonicalReport: final.canonicalReport,
        canonicalSource: final.canonicalSource,
        canonicalAbsentReason: final.canonicalAbsentReason,
        sessionId: final.sessionId,
        runLogPath: final.runLogPath,
        mcpToolCalls: final.mcpToolCalls,
      };
      return result;
    },
  };
}
