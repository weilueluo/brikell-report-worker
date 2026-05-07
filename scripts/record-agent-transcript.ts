#!/usr/bin/env tsx
/**
 * Live transcript recorder for the managed agent.
 *
 * Captures one real `runReportAgent` invocation as an NDJSON transcript
 * suitable for `replayReportRunner`. The output is committed under
 * `tests/fixtures/transcripts/` so the integration suite has realistic
 * fixtures without rerunning Anthropic for every test pass.
 *
 *   pnpm tsx scripts/record-agent-transcript.ts \
 *     --scenario basic-success \
 *     --address-id "addr-test-001" \
 *     --address-label "Test Address 1, 1000 København"
 *
 * Required environment:
 *   ANTHROPIC_API_KEY                 — the run uses real Anthropic
 *   ANTHROPIC_MODEL                   — usually claude-haiku-* for cheapness
 *   PLANDATA_BASE_URL, PLANDATA_API_TOKEN, ...   — provider creds
 *
 * The recorder sanitises the captured stream before writing the file:
 *   - removes API diagnostics that may include API keys,
 *   - rewrites absolute machine paths to "<machine-path>",
 *   - leaves Danish addresses as the agent saw them (test data is public
 *     property registry data; redact further at recording time if needed).
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRANSCRIPT_SCHEMA_VERSION,
  buildFinalEntry,
  parseTranscript,
  serializeTranscript,
  type McpCollectionEvidenceRecord,
  type TranscriptEntry,
  type TranscriptHeader,
} from "@brikell/shared";
import { runReportAgent } from "../src/agent/runner-client";
import type { AddressCandidate } from "@brikell/shared";

type Args = {
  scenario: string;
  addressId: string;
  addressLabel: string;
  postalCode?: string;
  city?: string;
};

function parseArgs(argv: ReadonlyArray<string>): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scenario") args.scenario = argv[++i];
    else if (a === "--address-id") args.addressId = argv[++i];
    else if (a === "--address-label") args.addressLabel = argv[++i];
    else if (a === "--postal-code") args.postalCode = argv[++i];
    else if (a === "--city") args.city = argv[++i];
  }
  for (const required of ["scenario", "addressId", "addressLabel"] as const) {
    if (!args[required]) {
      throw new Error(`record-agent-transcript: missing required --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    }
  }
  return args as Args;
}

function sanitiseString(value: string): string {
  return value
    .replace(/\b[A-Za-z]:[\\/][^\s'"]+/g, "<machine-path>")
    .replace(/sk-(?:ant|live)-[A-Za-z0-9_-]{8,}/g, "<redacted-key>");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const address: AddressCandidate = {
    id: args.addressId,
    label: args.addressLabel,
    postalCode: args.postalCode,
    city: args.city,
    coordinateSource: "selected-candidate",
  };

  const recordedAt = new Date().toISOString();
  const entries: TranscriptEntry[] = [];

  const result = await runReportAgent(
    `record-${args.scenario}`,
    address,
    (message) => {
      entries.push({ kind: "progress", message: sanitiseString(message) });
    },
  );

  const evidence: McpCollectionEvidenceRecord[] = result.mcpCollectionEvidence ?? [];
  for (const record of evidence) {
    entries.push({ kind: "collectionEvidence", record });
  }

  entries.push(
    buildFinalEntry({
      markdown: result.markdown,
      canonicalReport: result.canonicalReport,
      canonicalSource: result.canonicalSource,
      canonicalAbsentReason: result.canonicalAbsentReason
        ? sanitiseString(result.canonicalAbsentReason)
        : undefined,
      sessionId: result.sessionId,
      mcpCollectionEvidence: evidence,
    }),
  );

  const header: TranscriptHeader = {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    recordedAt,
    scenario: args.scenario,
  };
  const text = serializeTranscript({ header, entries });

  // Round-trip parse to fail loudly if the transcript is malformed before we
  // commit it.
  parseTranscript(text);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const outDir = join(__dirname, "..", "tests", "fixtures", "transcripts");
  const outFile = join(outDir, `${args.scenario}.jsonl`);
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, text, "utf8");
  console.log(`recorded ${outFile} (${entries.length} entries)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
