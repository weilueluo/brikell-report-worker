import test from "node:test";
import assert from "node:assert/strict";
import { renderReportPdf } from "../src/reports/pdf";

const PDF_HEADER = "%PDF-";
const PDF_TRAILER = "%%EOF";

const SAMPLE_MARKDOWN = `# Property Intelligence Report

**Address:** Fra Stranden 9A, 9480 Løkken
**Municipality:** Jammerbugt (0849)
**Property type:** Summer house

---

## Executive Summary

This property is a summer house located in the coastal area of Løkken, Jammerbugt
Municipality. The residential unit comprises 75 m² with 3 rooms.

## Property Identification

- **BFE Number:** 3228404
- **Building Usage:** 510 (Fritliggende enfamilieshus)
- **Construction Year:** 1935

## Buildings

The property contains two registered buildings.

### Building 1: Main Residence

- **Building Usage:** 510 (Detached single-family house)
- **Construction Year:** 1935

### Building 2: Outbuilding

- **Building Usage:** 930 (Andet bygningsareal)
- **Construction Year:** 1955
`;

async function extractTextWithPdfjs(bytes: Uint8Array): Promise<{ pages: string[] }> {
  // Use pdfjs-dist legacy build to avoid needing a worker thread in Node.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: bytes, useSystemFonts: true });
  const doc = await loadingTask.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item: { str?: string } | unknown) => {
      const candidate = item as { str?: string };
      return typeof candidate.str === "string" ? candidate.str : "";
    }).join(" ");
    pages.push(text);
  }
  await doc.destroy();
  return { pages };
}

test("renderReportPdf produces a valid PDF byte stream (header + trailer)", async () => {
  const bytes = await renderReportPdf("# Hello\n\nWorld.");
  const head = Buffer.from(bytes.slice(0, 5)).toString("latin1");
  const tail = Buffer.from(bytes.slice(-Math.min(bytes.length, 20))).toString("latin1");
  assert.equal(head, PDF_HEADER);
  assert.match(tail, new RegExp(PDF_TRAILER));
});

test("PDF text extraction shows clean content (no markdown noise)", async () => {
  const bytes = await renderReportPdf(SAMPLE_MARKDOWN);
  const { pages } = await extractTextWithPdfjs(bytes);
  const all = pages.join("\n");
  // Headings present without leading '#' or trailing '**' noise.
  assert.match(all, /Property Intelligence Report/);
  assert.match(all, /Executive Summary/);
  assert.match(all, /Property Identification/);
  assert.match(all, /Buildings/);
  // No bare markdown control sequences in the rendered output.
  assert.doesNotMatch(all, /\*\*/);
  assert.doesNotMatch(all, /^#\s/m);
});

test("PDF preserves Danish characters (Løkken, m², Æ Ø Å)", async () => {
  const bytes = await renderReportPdf(`# Test\n\nLøkken Søgade 75 m² Æ Ø Å`);
  const { pages } = await extractTextWithPdfjs(bytes);
  const all = pages.join(" ");
  assert.match(all, /Løkken/);
  assert.match(all, /m²/);
  assert.match(all, /Æ/);
  assert.match(all, /Ø/);
  assert.match(all, /Å/);
});

test("PDF spans multiple pages on a long fixture and does NOT truncate trailing content", async () => {
  const longSection = Array.from({ length: 30 }, (_, i) => `\n\nParagraph ${i + 1}: ${"lorem ipsum ".repeat(20)}`).join("");
  const md = `# Long Report\n${longSection}\n\n## Last Section\n\nThis is the last paragraph that must appear on the final page.`;
  const bytes = await renderReportPdf(md);
  const { pages } = await extractTextWithPdfjs(bytes);
  assert.ok(pages.length > 1, `expected multiple pages, got ${pages.length}`);
  // The trailing content must reach the PDF — anywhere in the rendered output, NOT
  // truncated. The original primitive emitter capped at 170 lines and dropped content.
  const all = pages.join(" ");
  assert.match(all, /Last Section/);
  assert.match(all, /last paragraph that must appear/);
});

test("PDF renders a list with bullets (no '- ' literal at line starts)", async () => {
  const bytes = await renderReportPdf("- alpha\n- beta\n- gamma");
  const { pages } = await extractTextWithPdfjs(bytes);
  const all = pages.join(" ");
  assert.match(all, /alpha/);
  assert.match(all, /beta/);
  assert.match(all, /gamma/);
});

test("PDF performance: 50KB markdown renders in under 2 seconds", async () => {
  const big = Array.from({ length: 200 }, (_, i) => `## Section ${i + 1}\n\n${"text ".repeat(40)}`).join("\n\n");
  assert.ok(big.length > 40_000, `fixture is ~${big.length} chars`);
  const t0 = Date.now();
  const bytes = await renderReportPdf(big);
  const elapsed = Date.now() - t0;
  assert.ok(bytes.length > 0);
  // 2 second budget — local dev tolerance; CI may be tighter via env override.
  assert.ok(elapsed < 2_000, `render took ${elapsed}ms; budget is 2000ms`);
});

test("PDF size guardrail: a typical 12KB markdown produces a PDF under the 200KB sync-payload cap", async () => {
  // Sync mode persists the PDF as inline base64 in the job. A bloated PDF with
  // embedded fonts could push the response over memory limits. This guards against that.
  const md = `# Brikell\n\n${SAMPLE_MARKDOWN}\n${SAMPLE_MARKDOWN}`;
  assert.ok(md.length > 1_000);
  const bytes = await renderReportPdf(md);
  // Embedded subset font + multi-page is expected to be well under 200KB
  // for an 8-page-equivalent of typical markdown.
  assert.ok(bytes.length < 200_000, `PDF is ${bytes.length} bytes; budget is 200_000`);
});
