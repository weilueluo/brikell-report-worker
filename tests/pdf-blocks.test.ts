import test from "node:test";
import assert from "node:assert/strict";
import { markdownToBlocks } from "../src/reports/pdf-blocks";

test("heading levels 1-3 round-trip", () => {
  const blocks = markdownToBlocks("# A\n\n## B\n\n### C");
  assert.deepEqual(
    blocks.map((b) => (b.kind === "heading" ? { kind: b.kind, level: b.level, text: b.spans.map((s) => s.text).join("") } : b)),
    [
      { kind: "heading", level: 1, text: "A" },
      { kind: "heading", level: 2, text: "B" },
      { kind: "heading", level: 3, text: "C" },
    ],
  );
});

test("bold spans inside paragraph", () => {
  const blocks = markdownToBlocks("Hello **world** today");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "paragraph");
  if (blocks[0].kind !== "paragraph") return;
  assert.deepEqual(blocks[0].spans, [
    { text: "Hello ", bold: false },
    { text: "world", bold: true },
    { text: " today", bold: false },
  ]);
});

test("dash list items are collected into a single list block", () => {
  const blocks = markdownToBlocks("- one\n- two\n- three");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "list");
  if (blocks[0].kind !== "list") return;
  assert.equal(blocks[0].items.length, 3);
  assert.equal(blocks[0].items[0].spans.map((s) => s.text).join(""), "one");
});

test("horizontal rule produces an hr block", () => {
  const blocks = markdownToBlocks("First\n\n---\n\nSecond");
  assert.equal(blocks.length, 3);
  assert.equal(blocks[1].kind, "hr");
});

test("multiple consecutive blank lines collapse", () => {
  const blocks = markdownToBlocks("A\n\n\n\nB");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "paragraph");
  assert.equal(blocks[1].kind, "paragraph");
});

test("unsupported code fence becomes a warning block; table and nested lists are supported", () => {
  const md = "Para\n\n```\ncode\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- Top\n  - Sub";
  const blocks = markdownToBlocks(md);
  // Code fence → warning. Table → table block. Nested list → ListBlock with children.
  const warnings = blocks.filter((b) => b.kind === "warning");
  assert.equal(warnings.length, 1, "only code fence warns");
  assert.equal(warnings[0].kind === "warning" ? warnings[0].reason : null, "unsupported_code");
  assert.ok(blocks.some((b) => b.kind === "table"), "table is rendered, not warned");
  const lists = blocks.filter((b) => b.kind === "list");
  assert.equal(lists.length, 1, "single top-level list with nested children");
  if (lists[0].kind === "list") {
    const top = lists[0].items[0];
    assert.ok(top.children && top.children.length > 0, "nested children captured");
  }
});

test("Danish characters survive the parser unchanged", () => {
  const blocks = markdownToBlocks("**Address:** Fra Stranden 9A, 9480 Løkken (75 m²)");
  assert.equal(blocks.length, 1);
  if (blocks[0].kind !== "paragraph") throw new Error("expected paragraph");
  const text = blocks[0].spans.map((s) => s.text).join("");
  assert.match(text, /Løkken/);
  assert.match(text, /m²/);
});

test("unmatched bold marker is treated as literal text", () => {
  const blocks = markdownToBlocks("Hello **world today");
  assert.equal(blocks.length, 1);
  if (blocks[0].kind !== "paragraph") return;
  // marked: an unmatched bold marker remains as literal text. We accept either
  // "as-is" or "stripped" — but it must NOT throw and must NOT swallow content.
  const text = blocks[0].spans.map((s) => s.text).join("");
  assert.match(text, /Hello/);
  assert.match(text, /world today/);
});

test("paragraph after list resets to paragraph block", () => {
  const blocks = markdownToBlocks("- one\n- two\n\nAfter");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "list");
  assert.equal(blocks[1].kind, "paragraph");
});

test("empty input produces no blocks", () => {
  assert.deepEqual(markdownToBlocks(""), []);
  assert.deepEqual(markdownToBlocks("\n\n  \n"), []);
});

test("the canonical-rendered markdown of a known fixture parses to non-empty blocks with no warnings", async () => {
  // Verifies the parity between canonical→markdown→blocks: when the source is our
  // deterministic V1 renderer (not the agent's free-text), the parser produces a
  // clean block sequence with NO unsupported-token warnings.
  const { renderReportV1Markdown, deltaParkV1Fixture } = await import("@brikell/shared");
  const md = renderReportV1Markdown(deltaParkV1Fixture);
  const blocks = markdownToBlocks(md);
  assert.ok(blocks.length > 0, "fixture renders to blocks");
  const warnings = blocks.filter((b) => b.kind === "warning");
  assert.equal(warnings.length, 0, `canonical fixture must not produce warnings; got: ${JSON.stringify(warnings)}`);
});
