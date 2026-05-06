import assert from "node:assert/strict";
import { test } from "node:test";

import { buildToolCallBuffer, deriveProvider, type ManagedRunEvent } from "../src/agent/runner-client";

function event(kind: ManagedRunEvent["kind"], message: string, details?: unknown): ManagedRunEvent {
  return { kind, message, details };
}

test("deriveProvider recognises known prefixes", () => {
  assert.equal(deriveProvider("dataforsyningen.search_address_or_place"), "dataforsyningen");
  assert.equal(deriveProvider("datafordeler.resolve_property"), "datafordeler");
  assert.equal(deriveProvider("plandata.find_plans_by_geometry"), "plandata");
  assert.equal(deriveProvider("supabase.execute_sql"), "supabase");
});

test("deriveProvider falls back to managed-agent for unknown tools", () => {
  assert.equal(deriveProvider("read"), "managed-agent");
  assert.equal(deriveProvider("bash"), "managed-agent");
  assert.equal(deriveProvider("write"), "managed-agent");
});

test("deriveProvider extracts namespace from dotted unknown tool names", () => {
  assert.equal(deriveProvider("custom.do_thing"), "custom");
  assert.equal(deriveProvider("scope/segment.do_thing"), "scope");
});

test("buildToolCallBuffer pairs a single tool-use with its result", () => {
  const buffer = buildToolCallBuffer();
  buffer.ingest(event("tool", "dataforsyningen.search_address_or_place", { input: { query: "Delta Park" }, server: "dataforsyningen" }));
  buffer.ingest(event("result", "MCP tool result", { ok: true, content: { matches: 1, _ref: { source: "dataforsyningen.dar", upstreamId: "Delta Park", fetchedAt: "2026-01-01T00:00:00.000Z" } } }));

  const records = buffer.snapshot();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.toolName, "dataforsyningen.search_address_or_place");
  assert.equal(records[0]!.provider, "dataforsyningen");
  assert.deepEqual(records[0]!.args, { query: "Delta Park" });
  assert.deepEqual(records[0]!.result, { matches: 1, _ref: { source: "dataforsyningen.dar", upstreamId: "Delta Park", fetchedAt: "2026-01-01T00:00:00.000Z" } });
  const provenance = records[0]!.sourceProvenance as Record<string, unknown>;
  assert.equal(provenance.server, "dataforsyningen");
  assert.deepEqual(provenance.dataSources, ["dataforsyningen.dar"]);
  assert.deepEqual(provenance.upstreamIds, ["Delta Park"]);
  assert.equal(records[0]!.ok, true);
});

test("buildToolCallBuffer records ok=false on error result and copies the message into diagnostic", () => {
  const buffer = buildToolCallBuffer();
  buffer.ingest(event("tool", "datafordeler.resolve_property", { input: { bfeNumber: "0" } }));
  buffer.ingest(event("result", "MCP tool result error", { ok: false, content: "validation failed" }));

  const records = buffer.snapshot();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.ok, false);
  assert.equal(records[0]!.diagnostic, "MCP tool result error");
  assert.equal(records[0]!.result, "validation failed");
});

test("buildToolCallBuffer marks an unresolved tool when followed by another tool", () => {
  const buffer = buildToolCallBuffer();
  buffer.ingest(event("tool", "datafordeler.resolve_property", { input: { bfeNumber: "1" } }));
  buffer.ingest(event("tool", "plandata.coverage_status", { input: {} }));
  buffer.ingest(event("result", "MCP tool result", { ok: true, content: { coverage: "ok", _ref: { source: "plandata", fetchedAt: "2026-01-01T00:00:00.000Z" } } }));

  const records = buffer.snapshot();
  assert.equal(records.length, 2);
  assert.equal(records[0]!.toolName, "datafordeler.resolve_property");
  assert.equal(records[0]!.ok, false);
  assert.equal(records[0]!.diagnostic, "no result event before next tool call");
  assert.equal(records[1]!.toolName, "plandata.coverage_status");
  assert.equal(records[1]!.ok, true);
  assert.deepEqual(records[1]!.result, { coverage: "ok", _ref: { source: "plandata", fetchedAt: "2026-01-01T00:00:00.000Z" } });
});

test("buildToolCallBuffer flags a tool result missing the _ref provenance contract", () => {
  const buffer = buildToolCallBuffer();
  buffer.ingest(event("tool", "datafordeler.resolve_property", { input: { bfeNumber: "9" } }));
  buffer.ingest(event("result", "MCP tool result", { ok: true, content: { matches: [] } }));

  const records = buffer.snapshot();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.ok, false);
  assert.match(String(records[0]!.diagnostic ?? ""), /^bridge_missing_provenance:/);
});

test("buildToolCallBuffer emits a synthetic record for orphan results", () => {
  const buffer = buildToolCallBuffer();
  buffer.ingest(event("result", "MCP tool result", { ok: true, content: { stray: 1 } }));

  const records = buffer.snapshot();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.toolName, "MCP tool result");
  assert.equal(records[0]!.provider, "managed-agent");
  assert.deepEqual(records[0]!.result, { stray: 1 });
});

test("buildToolCallBuffer ignores non-tool/result events", () => {
  const buffer = buildToolCallBuffer();
  buffer.ingest(event("agent", "model thinking"));
  buffer.ingest(event("running", "session running"));
  buffer.ingest(event("event", "context compacted"));

  assert.deepEqual(buffer.snapshot(), []);
});

test("buildToolCallBuffer snapshot returns independent copies", () => {
  const buffer = buildToolCallBuffer();
  buffer.ingest(event("tool", "datafordeler.resolve_property", { input: { bfeNumber: "1" } }));
  buffer.ingest(event("result", "ok", { ok: true, content: { value: 1 } }));

  const a = buffer.snapshot();
  const b = buffer.snapshot();
  assert.deepEqual(a, b);
  a[0]!.toolName = "mutated";
  assert.notEqual(a[0]!.toolName, b[0]!.toolName);
});
