import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sanitizeEventPayload,
  structuredEvent,
} from "../../src/agent/managed/structured-events";

test("sanitizeEventPayload returns primitives unchanged", () => {
  assert.equal(sanitizeEventPayload(42), 42);
  assert.equal(sanitizeEventPayload(null), null);
  assert.equal(sanitizeEventPayload(true), true);
});

test("sanitizeEventPayload redacts bearer tokens, key=value secrets, and authorization headers in strings", () => {
  assert.equal(
    sanitizeEventPayload("Authorization: Bearer abc123def456"),
    "Authorization: Bearer [redacted]",
  );
  assert.equal(sanitizeEventPayload("token=hunter2,other=foo"), "token=[redacted],other=foo");
  assert.equal(sanitizeEventPayload("api_key=keyvalue"), "api_key=[redacted]");
});

test("sanitizeEventPayload redacts the values of sensitive keys in objects", () => {
  const out = sanitizeEventPayload({
    authorization: "Bearer xyz",
    apiKey: "k",
    cookie: "session=abc",
    nested: { password: "p", safe: "value" },
    safe: "plain",
  });
  assert.deepEqual(out, {
    authorization: "[redacted]",
    apiKey: "[redacted]",
    cookie: "[redacted]",
    nested: { password: "[redacted]", safe: "value" },
    safe: "plain",
  });
});

test("sanitizeEventPayload returns '[circular]' for self-referential objects without throwing", () => {
  const a: Record<string, unknown> = { name: "root" };
  a.child = a;
  const out = sanitizeEventPayload(a) as Record<string, unknown>;
  assert.equal(out.name, "root");
  assert.equal(out.child, "[circular]");
});

test("sanitizeEventPayload recurses into arrays preserving order and redaction rules", () => {
  const out = sanitizeEventPayload([{ token: "x" }, "Bearer abc"]);
  assert.deepEqual(out, [{ token: "[redacted]" }, "Bearer [redacted]"]);
});

test("sanitizeEventPayload truncates payloads larger than the supplied character cap", () => {
  const out = sanitizeEventPayload({ huge: "x".repeat(200) }, 50) as {
    truncated: true;
    originalChars: number;
    excerpt: string;
  };
  assert.equal(out.truncated, true);
  assert.ok(out.originalChars > 50);
  assert.equal(out.excerpt.length, 50);
});

test("structuredEvent emits a single NDJSON line with event/ts/payload fields", () => {
  const line = structuredEvent("worker.ping", { latency_ms: 42 });
  assert.ok(line.endsWith("\n"));
  const parsed = JSON.parse(line.trimEnd()) as Record<string, unknown>;
  assert.equal(parsed.event, "worker.ping");
  assert.deepEqual(parsed.payload, { latency_ms: 42 });
  assert.match(parsed.ts as string, /^\d{4}-\d{2}-\d{2}T/);
});

test("structuredEvent defaults the payload to {} when none is provided", () => {
  const parsed = JSON.parse(structuredEvent("worker.idle").trimEnd()) as Record<string, unknown>;
  assert.deepEqual(parsed.payload, {});
});
