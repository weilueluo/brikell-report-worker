import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildFinalEntry,
  parseTranscript,
  serializeTranscript,
  TRANSCRIPT_SCHEMA_VERSION,
  TranscriptParseError,
  type McpCollectionEvidenceRecord,
  type TranscriptEntry,
  type TranscriptHeader,
} from "@brikell/shared";

const VALID_HEADER: TranscriptHeader = {
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  recordedAt: "2026-05-07T00:00:00.000Z",
  scenario: "test-scenario",
};

function evidenceRecord(overrides: Partial<McpCollectionEvidenceRecord> = {}): McpCollectionEvidenceRecord {
  return {
    collectionId: "0193f2c7-aaaa-bbbb-cccc-000000000001",
    intent: "property.collect",
    ref: {
      source: "datafordeler",
      upstreamId: "100004482",
      fetchedAt: "2026-05-07T00:00:01.000Z",
    },
    responseSha256: "sha256:test",
    counts: { records: 47, documents: 0 },
    ...overrides,
  };
}

function transcript(lines: ReadonlyArray<unknown>): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

test("parseTranscript accepts a minimal valid transcript and exposes header + final", () => {
  const final = { kind: "final" as const, mcpCollectionEvidence: [evidenceRecord()] };
  const text = transcript([VALID_HEADER, final]);
  const parsed = parseTranscript(text);
  assert.deepEqual(parsed.header, VALID_HEADER);
  assert.equal(parsed.final.kind, "final");
  assert.equal(parsed.final.mcpCollectionEvidence.length, 1);
  assert.equal(parsed.entries.length, 1);
});

test("parseTranscript rejects a transcript with fewer than two lines", () => {
  assert.throws(
    () => parseTranscript(transcript([VALID_HEADER])),
    (error: unknown) =>
      error instanceof TranscriptParseError && /at least a header line and a final entry/.test(error.message),
  );
});

test("parseTranscript rejects an empty string", () => {
  assert.throws(
    () => parseTranscript(""),
    (error: unknown) => error instanceof TranscriptParseError,
  );
});

test("parseTranscript rejects an invalid JSON header at line 1", () => {
  const text = `not-json\n${JSON.stringify({ kind: "final", mcpCollectionEvidence: [evidenceRecord()] })}\n`;
  assert.throws(
    () => parseTranscript(text),
    (error: unknown) =>
      error instanceof TranscriptParseError && /invalid transcript header at line 1/.test(error.message),
  );
});

test("parseTranscript rejects an invalid header that fails schema validation", () => {
  const text = transcript([
    { schemaVersion: 999, recordedAt: "not-a-date", scenario: "" },
    { kind: "final", mcpCollectionEvidence: [evidenceRecord()] },
  ]);
  assert.throws(
    () => parseTranscript(text),
    (error: unknown) =>
      error instanceof TranscriptParseError && /invalid transcript header at line 1/.test(error.message),
  );
});

test("parseTranscript rejects a malformed JSON line in the middle of a transcript", () => {
  const text = `${JSON.stringify(VALID_HEADER)}\n{not-json\n${JSON.stringify({ kind: "final", mcpCollectionEvidence: [evidenceRecord()] })}\n`;
  assert.throws(
    () => parseTranscript(text),
    (error: unknown) =>
      error instanceof TranscriptParseError && /invalid transcript entry at line 2/.test(error.message),
  );
});

test("parseTranscript rejects an unknown entry kind", () => {
  const text = transcript([
    VALID_HEADER,
    { kind: "unknown" },
    { kind: "final", mcpCollectionEvidence: [evidenceRecord()] },
  ]);
  assert.throws(
    () => parseTranscript(text),
    (error: unknown) =>
      error instanceof TranscriptParseError && /invalid transcript entry at line 2/.test(error.message),
  );
});

test("parseTranscript rejects a transcript missing the final entry", () => {
  const text = transcript([
    VALID_HEADER,
    { kind: "progress", message: "starting" },
    { kind: "progress", message: "still going" },
  ]);
  assert.throws(
    () => parseTranscript(text),
    (error: unknown) =>
      error instanceof TranscriptParseError && /must end with a "final" entry/.test(error.message),
  );
});

test("parseTranscript rejects a final entry that is not the last line", () => {
  const text = transcript([
    VALID_HEADER,
    { kind: "final", mcpCollectionEvidence: [evidenceRecord()] },
    { kind: "progress", message: "after final" },
  ]);
  assert.throws(
    () => parseTranscript(text),
    (error: unknown) =>
      error instanceof TranscriptParseError && /"final" entry must be the last line/.test(error.message),
  );
});

test("parseTranscript rejects a duplicate final entry", () => {
  const text = transcript([
    VALID_HEADER,
    { kind: "final", mcpCollectionEvidence: [evidenceRecord()] },
    { kind: "final", mcpCollectionEvidence: [evidenceRecord()] },
  ]);
  assert.throws(
    () => parseTranscript(text),
    (error: unknown) =>
      error instanceof TranscriptParseError && /must contain exactly one "final" entry/.test(error.message),
  );
});

test("parseTranscript rejects collection-evidence missing ref.source", () => {
  const text = transcript([
    VALID_HEADER,
    {
      kind: "final",
      mcpCollectionEvidence: [
        {
          ...evidenceRecord(),
          // The schema requires `ref.source` to be a non-empty string. The
          // post-parse cross-check at L142 also asserts presence — both
          // layers should reject.
          ref: { source: "", fetchedAt: "2026-05-07T00:00:01.000Z" },
        },
      ],
    },
  ]);
  assert.throws(
    () => parseTranscript(text),
    (error: unknown) => error instanceof TranscriptParseError,
  );
});

test("parseTranscript rejects a document missing source/upstreamId/sha256", () => {
  const text = transcript([
    VALID_HEADER,
    {
      kind: "final",
      mcpCollectionEvidence: [
        {
          ...evidenceRecord({ counts: { records: 1, documents: 1 } }),
          documents: [
            {
              documentId: "doc-1",
              source: "",
              upstreamId: "plan-doc-1",
              sha256: "sha256:abc",
              byteSize: 1024,
              extractionStatus: "ok" as const,
            },
          ],
        },
      ],
    },
  ]);
  assert.throws(
    () => parseTranscript(text),
    (error: unknown) => error instanceof TranscriptParseError,
  );
});

test("parseTranscript rejects documents.length mismatching counts.documents when both populated", () => {
  const text = transcript([
    VALID_HEADER,
    {
      kind: "final",
      mcpCollectionEvidence: [
        {
          ...evidenceRecord({ counts: { records: 1, documents: 3 } }),
          documents: [
            {
              documentId: "doc-1",
              source: "plandata",
              upstreamId: "plan-doc-1",
              sha256: "sha256:abc",
              byteSize: 1024,
              extractionStatus: "ok" as const,
            },
          ],
        },
      ],
    },
  ]);
  assert.throws(
    () => parseTranscript(text),
    (error: unknown) =>
      error instanceof TranscriptParseError &&
      /documents\.length \(1\) does not match counts\.documents \(3\)/.test(error.message),
  );
});

test("serializeTranscript -> parseTranscript roundtrips header + entries verbatim", () => {
  const entries: TranscriptEntry[] = [
    { kind: "progress", message: "step 1" },
    { kind: "collectionEvidence", record: evidenceRecord() },
    {
      kind: "final",
      mcpCollectionEvidence: [evidenceRecord()],
      sessionId: "sess-roundtrip",
    },
  ];
  const text = serializeTranscript({ header: VALID_HEADER, entries });
  const parsed = parseTranscript(text);
  assert.deepEqual(parsed.header, VALID_HEADER);
  assert.deepEqual(parsed.entries, entries);
  assert.equal(parsed.final.sessionId, "sess-roundtrip");
});

test("buildFinalEntry preserves all optional fields and stamps kind=final", () => {
  const record = evidenceRecord();
  const entry = buildFinalEntry({
    markdown: "# report",
    sessionId: "sess-build",
    runLogPath: "/tmp/run.log",
    canonicalSource: "runner",
    mcpCollectionEvidence: [record],
  });
  assert.equal(entry.kind, "final");
  assert.equal(entry.markdown, "# report");
  assert.equal(entry.sessionId, "sess-build");
  assert.equal(entry.runLogPath, "/tmp/run.log");
  assert.equal(entry.canonicalSource, "runner");
  assert.deepEqual(entry.mcpCollectionEvidence, [record]);
});

test("parseTranscript trims trailing blank lines (file may end with \\n or \\r\\n)", () => {
  const final = { kind: "final" as const, mcpCollectionEvidence: [evidenceRecord()] };
  const text = `${JSON.stringify(VALID_HEADER)}\r\n${JSON.stringify(final)}\r\n\r\n`;
  const parsed = parseTranscript(text);
  assert.equal(parsed.final.kind, "final");
});
