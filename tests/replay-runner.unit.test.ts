import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  parseTranscript,
  serializeTranscript,
  type TranscriptEntry,
  type TranscriptHeader,
} from "@brikell/shared";
import type { AddressCandidate } from "@brikell/shared";
import { replayReportRunner } from "./fixtures/runners/replay-runner";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_DIR = join(__dirname, "fixtures", "transcripts");

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

test("replayReportRunner replays progress messages and returns the final result", async () => {
  const runner = replayReportRunner({ path: join(FIXTURE_DIR, "basic-success.jsonl") });
  await runner.ensureReady();

  const progress: string[] = [];
  const result = await runner.run("job-replay", candidate(), (message) => {
    progress.push(message);
  });

  assert.deepEqual(progress, [
    "Starting managed report runner.",
    "Resolving address candidate.",
    "Looking up property identifier.",
    "Compiling canonical report.",
  ]);

  assert.equal(result.canonicalSource, "runner");
  assert.equal(result.sessionId, "fixture-session-basic");
  assert.ok(result.markdown && result.markdown.length > 0);
  assert.equal(result.canonicalReport?.schemaVersion, "v1");
  assert.equal(result.mcpCollectionEvidence.length, 2);
  assert.equal(result.mcpCollectionEvidence[0]!.intent, "address.resolve");
  assert.equal(result.mcpCollectionEvidence[0]!.ref.source, "dataforsyningen.dar");
  assert.equal(result.mcpCollectionEvidence[1]!.intent, "property.collect");
});

test("replayReportRunner returns the canonical-absent reason from a runner-error transcript", async () => {
  const runner = replayReportRunner({ path: join(FIXTURE_DIR, "runner-error.jsonl") });

  const result = await runner.run("job-replay-err", candidate());

  assert.equal(result.canonicalReport, undefined);
  assert.equal(result.canonicalAbsentReason, "Address lookup failed; cannot continue.");
  assert.equal(result.mcpCollectionEvidence.length, 0);
});

test("parseTranscript rejects collection-evidence with documents.length not matching counts.documents", async () => {
  const header: TranscriptHeader = {
    schemaVersion: 1,
    recordedAt: "2026-01-01T00:00:00.000Z",
    scenario: "doc-mismatch",
  };
  const entries: TranscriptEntry[] = [
    {
      kind: "final",
      mcpCollectionEvidence: [
        {
          collectionId: "col_1",
          intent: "property.collect",
          ref: { source: "ds", upstreamId: "u", fetchedAt: "2026-01-01T00:00:00.000Z" },
          responseSha256: "f".repeat(64),
          counts: { records: 1, documents: 2 },
          documents: [
            {
              documentId: "d1",
              source: "ds",
              upstreamId: "u-d1",
              sha256: "a".repeat(64),
              byteSize: 10,
              extractionStatus: "ok",
            },
          ],
        },
      ],
    },
  ];
  const text = serializeTranscript({ header, entries });
  assert.throws(() => parseTranscript(text), /does not match counts\.documents/);
});

test("parseTranscript rejects a transcript with two final entries", async () => {
  const header: TranscriptHeader = {
    schemaVersion: 1,
    recordedAt: "2026-01-01T00:00:00.000Z",
    scenario: "double-final",
  };
  const entries: TranscriptEntry[] = [
    { kind: "final", mcpCollectionEvidence: [] },
    { kind: "final", mcpCollectionEvidence: [] },
  ];
  const text = serializeTranscript({ header, entries });
  assert.throws(() => parseTranscript(text), /exactly one "final" entry/);
});

test("replayReportRunner accepts an in-memory transcript via parsed input", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "replay-runner-"));
  const header: TranscriptHeader = {
    schemaVersion: 1,
    recordedAt: "2026-01-01T00:00:00.000Z",
    scenario: "inline",
  };
  const entries: TranscriptEntry[] = [
    { kind: "progress", message: "Hello" },
    {
      kind: "final",
      markdown: "# inline",
      sessionId: "session-inline",
      mcpCollectionEvidence: [],
    },
  ];
  const path = join(tmp, "inline.jsonl");
  await writeFile(path, serializeTranscript({ header, entries }), "utf8");
  const runner = replayReportRunner({ path });
  const messages: string[] = [];
  const result = await runner.run("job-inline", candidate(), (m) => {
    messages.push(m);
  });
  assert.deepEqual(messages, ["Hello"]);
  assert.equal(result.markdown, "# inline");
  assert.equal(result.sessionId, "session-inline");
});
