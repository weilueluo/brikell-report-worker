import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatElapsedDuration,
  formatInlineText,
  formatSessionTimelineEntry,
  formatTimelinePayload,
} from "../src/agent/managed/session-timeline";

test("formatElapsedDuration formats H:MM:SS for known durations", () => {
  assert.equal(formatElapsedDuration(0), "0:00:00");
  assert.equal(formatElapsedDuration(999), "0:00:00");
  assert.equal(formatElapsedDuration(1_000), "0:00:01");
  assert.equal(formatElapsedDuration(60 * 1000), "0:01:00");
  assert.equal(formatElapsedDuration(75 * 1000), "0:01:15");
  assert.equal(formatElapsedDuration(3_600 * 1000 + 5_000), "1:00:05");
});

test("formatElapsedDuration treats non-finite or negative input as zero", () => {
  assert.equal(formatElapsedDuration(Number.NaN), "0:00:00");
  assert.equal(formatElapsedDuration(-1), "0:00:00");
  assert.equal(formatElapsedDuration(Number.POSITIVE_INFINITY), "0:00:00");
});

test("formatInlineText collapses whitespace and trims", () => {
  assert.equal(formatInlineText("  hello   world  ", 20), "hello world");
});

test("formatInlineText truncates with an ellipsis when exceeding maxChars", () => {
  assert.equal(formatInlineText("hello world", 8), "hello...");
});

test("formatInlineText falls back to dots only when maxChars is too small for an ellipsis", () => {
  assert.equal(formatInlineText("hello", 2), "..");
  assert.equal(formatInlineText("hello", 0), "");
});

test("formatTimelinePayload returns empty string for undefined or empty input", () => {
  assert.equal(formatTimelinePayload(undefined), "");
  assert.equal(formatTimelinePayload(""), "");
  assert.equal(formatTimelinePayload("   "), "");
});

test("formatTimelinePayload pretty-renders inline JSON when the input parses", () => {
  const out = formatTimelinePayload(`{"a":1,"b":"two"}`);
  assert.equal(out, `{"a":1,"b":"two"}`);
});

test("formatTimelinePayload sanitizes objects (e.g., redacts credential-shaped fields)", () => {
  const out = formatTimelinePayload({ token: "secret", id: "x" });
  // sanitizeEventPayload either redacts or drops the token field; the result
  // must not contain the secret value verbatim.
  assert.doesNotMatch(out, /secret/);
  assert.match(out, /"id":"x"/);
});

test("formatTimelinePayload truncates oversized payloads with maxChars", () => {
  const long = "x".repeat(500);
  const out = formatTimelinePayload(long, 20);
  assert.ok(out.length <= 20);
  assert.ok(out.endsWith("..."));
});

test("formatSessionTimelineEntry renders a label, message, and right-aligned elapsed when present", () => {
  const out = formatSessionTimelineEntry(
    { kind: "tool", message: "datafordeler.property.resolve_property", elapsedMs: 75_000 },
    { columns: 80 },
  );
  // Label is left-padded to a fixed column width and lowercased to "[Tool]".
  assert.match(out, /^\[Tool\] {6}/);
  // Elapsed time is right-aligned at end of line.
  assert.ok(out.trimEnd().endsWith("0:01:15"));
  assert.equal(out.length, 80);
});

test("formatSessionTimelineEntry omits elapsed column when elapsedMs is undefined", () => {
  const out = formatSessionTimelineEntry({ kind: "agent", message: "hello" });
  // Label `[Agent]` (7 chars) padEnd(12) = 5 trailing spaces, then 1 separator
  // space, so 6 spaces sit between `]` and the message.
  assert.match(out, /^\[Agent\] {6}hello$/);
});

test("formatSessionTimelineEntry falls back to the default column width for invalid columns", () => {
  const a = formatSessionTimelineEntry({ kind: "user", message: "x", elapsedMs: 0 }, { columns: -10 });
  const b = formatSessionTimelineEntry({ kind: "user", message: "x", elapsedMs: 0 }, { columns: undefined });
  assert.equal(a.length, b.length);
});
