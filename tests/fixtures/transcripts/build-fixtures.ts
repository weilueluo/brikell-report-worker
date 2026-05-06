/**
 * Synthetic transcript builder. Run with `pnpm tsx` to regenerate the
 * baseline transcripts under `tests/fixtures/transcripts/`.
 *
 * These transcripts are NOT recordings of real Anthropic runs (the recorder
 * for that lives at `scripts/record-agent-transcript.ts`). They exist so the
 * replay-runner test path has known-shaped input to validate the loader,
 * progress fan-out, mcpToolCalls plumbing, and provenance enforcement
 * without burning Anthropic credits.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  TRANSCRIPT_SCHEMA_VERSION,
  buildFinalEntry,
  parseTranscript,
  serializeTranscript,
  stampPayload,
  type McpToolCallRecord,
  type TranscriptEntry,
  type TranscriptHeader,
} from "@brikell/shared";
import {
  buildFixtureCanonicalReport,
  buildFixtureReportMarkdown,
} from "../runners/fixture-results.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ADDRESS = {
  id: "addr-test-001",
  label: "Test Address 1, 1000 København",
  postalCode: "1000",
  city: "København",
  coordinateSource: "selected-candidate" as const,
  source: { provider: "Dataforsyningen" as const },
};

const FIXTURE_RECORDED_AT = "2026-01-01T00:00:00.000Z";

function buildHeader(scenario: string): TranscriptHeader {
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    recordedAt: FIXTURE_RECORDED_AT,
    scenario,
  };
}

function buildBasicSuccess(): { header: TranscriptHeader; entries: TranscriptEntry[] } {
  const header = buildHeader("basic-success");
  const stampedAddressResult = stampPayload(
    {
      records: [
        stampPayload(
          {
            id: "addr-test-001",
            label: ADDRESS.label,
            postalCode: ADDRESS.postalCode,
            city: ADDRESS.city,
          },
          { source: "dataforsyningen.dar", upstreamId: "addr-test-001" },
        ),
      ],
    },
    { source: "dataforsyningen.dar", upstreamId: "addr-test-001" },
  );
  const stampedBfeResult = stampPayload(
    {
      bfeNumber: "1234567",
      address: ADDRESS.label,
    },
    { source: "datafordeler.ejendom", upstreamId: "1234567" },
  );

  const toolCalls: McpToolCallRecord[] = [
    {
      toolName: "search_address",
      provider: "dataforsyningen",
      args: { query: ADDRESS.label },
      result: stampedAddressResult,
      fetchedAt: FIXTURE_RECORDED_AT,
      durationMs: 120,
      ok: true,
      sourceProvenance: {
        source: "dataforsyningen.dar",
        upstreamId: "addr-test-001",
        fetchedAt: FIXTURE_RECORDED_AT,
      },
    },
    {
      toolName: "lookup_bfe",
      provider: "datafordeler",
      args: { addressId: "addr-test-001" },
      result: stampedBfeResult,
      fetchedAt: FIXTURE_RECORDED_AT,
      durationMs: 95,
      ok: true,
      sourceProvenance: {
        source: "datafordeler.ejendom",
        upstreamId: "1234567",
        fetchedAt: FIXTURE_RECORDED_AT,
      },
    },
  ];

  const entries: TranscriptEntry[] = [
    { kind: "progress", message: "Starting managed report runner." },
    { kind: "progress", message: "Resolving address candidate." },
    { kind: "toolCall", record: toolCalls[0]! },
    { kind: "progress", message: "Looking up property identifier." },
    { kind: "toolCall", record: toolCalls[1]! },
    { kind: "progress", message: "Compiling canonical report." },
    buildFinalEntry({
      markdown: buildFixtureReportMarkdown("fixture-job-basic", ADDRESS),
      canonicalReport: buildFixtureCanonicalReport(
        "fixture-job-basic",
        ADDRESS,
        FIXTURE_RECORDED_AT,
      ),
      canonicalSource: "runner",
      sessionId: "fixture-session-basic",
      mcpToolCalls: toolCalls,
    }),
  ];

  return { header, entries };
}

function buildRunnerError(): { header: TranscriptHeader; entries: TranscriptEntry[] } {
  const header = buildHeader("runner-error");
  const failedToolCall: McpToolCallRecord = {
    toolName: "search_address",
    provider: "dataforsyningen",
    args: { query: ADDRESS.label },
    fetchedAt: FIXTURE_RECORDED_AT,
    durationMs: 1200,
    ok: false,
    diagnostic: "Upstream timeout after 1200ms",
    sourceProvenance: {
      source: "dataforsyningen.dar",
      fetchedAt: FIXTURE_RECORDED_AT,
    },
  };

  const entries: TranscriptEntry[] = [
    { kind: "progress", message: "Starting managed report runner." },
    { kind: "progress", message: "Resolving address candidate." },
    { kind: "toolCall", record: failedToolCall },
    { kind: "progress", message: "Address lookup failed; recording diagnostic." },
    buildFinalEntry({
      canonicalAbsentReason: "Address lookup failed; cannot continue.",
      sessionId: "fixture-session-error",
      mcpToolCalls: [failedToolCall],
    }),
  ];

  return { header, entries };
}

async function emit(
  scenario: string,
  payload: { header: TranscriptHeader; entries: TranscriptEntry[] },
): Promise<void> {
  const text = serializeTranscript(payload);
  parseTranscript(text);
  const target = join(__dirname, `${scenario}.jsonl`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
  console.log(`wrote ${target}`);
}

async function main(): Promise<void> {
  await emit("basic-success", buildBasicSuccess());
  await emit("runner-error", buildRunnerError());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
