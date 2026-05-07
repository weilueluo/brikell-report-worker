import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSkillStatusLine } from "../../src/agent/managed/skill-status-parser";

test("parseSkillStatusLine accepts a success status line", () => {
  const result = parseSkillStatusLine(JSON.stringify({
    ok: true,
    intent: "property.collect",
    collection_id: "collection-1",
    request_key: "request-sha",
    status: "success",
    ref: { source: "datafordeler", upstreamId: "100004482", fetchedAt: "2026-05-01T00:00:00.000Z" },
    counts: { records: 47, documents: 0 },
    response_sha256: "response-sha",
    response_bytes: 138420,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.status.ok, true);
  assert.equal(result.ok && result.status.intent, "property.collect");
});

test("parseSkillStatusLine accepts a failure status line", () => {
  const result = parseSkillStatusLine(JSON.stringify({
    ok: false,
    intent: "planning.collect",
    code: "upstream_timeout",
    retryable: true,
    safe_message: "Planning collection timed out.",
    partial_collection_id: null,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.status.ok, false);
  if (!result.ok || result.status.ok) throw new Error("expected parsed failure status");
  assert.equal(result.status.code, "upstream_timeout");
});

test("parseSkillStatusLine drops oversized status lines", () => {
  const result = parseSkillStatusLine(`{"ok":${" ".repeat(4097)}}`);
  assert.deepEqual(result, { ok: false, code: "internal_oversized_status" });
});

test("parseSkillStatusLine drops invalid JSON", () => {
  const result = parseSkillStatusLine("{not-json");
  assert.deepEqual(result, { ok: false, code: "invalid_status_line" });
});

test("parseSkillStatusLine drops malformed status shapes", () => {
  const result = parseSkillStatusLine(JSON.stringify({ ok: true, intent: "property.collect" }));
  assert.deepEqual(result, { ok: false, code: "invalid_status_line" });
});
