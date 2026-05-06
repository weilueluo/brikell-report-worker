import { resolve } from "node:path";
import PDFDocument from "pdfkit";
import { markdownToBlocks, type Block, type TextSpan } from "./pdf-blocks";

/**
 * Render a Markdown report into a PDF.
 *
 * Why async:
 * - pdfkit is stream/event oriented (`doc.on("data" | "end")`)
 * - sync wrappers around streams hide subtle bugs; explicit Promise is honest
 *
 * Source-of-truth strategy (per the long-term design):
 * - Caller passes `markdown` (already canonical-rendered when possible)
 * - We don't branch the renderer on canonical vs free-text — both go through
 *   the same `markdownToBlocks` pipeline; canonical wins by being normalized
 *   to clean Markdown by `renderReportV1Markdown` upstream.
 *
 * Fonts:
 * - Embedded TTFs (Noto Sans Regular + Bold) for full Latin Extended coverage
 *   so Danish characters like Løkken, Søgade, m² render correctly.
 */

const A4_WIDTH = 595;
const A4_HEIGHT = 842;
const PAGE_MARGIN = 56; // ~2cm
const FONT_REGULAR = "regular";
const FONT_BOLD = "bold";

let cachedFontPaths: { regular: string; bold: string } | undefined;

function resolveFontPaths(): { regular: string; bold: string } {
  if (cachedFontPaths) return cachedFontPaths;
  const root = process.cwd();
  cachedFontPaths = {
    regular: resolve(root, "assets/fonts/NotoSans-Regular.ttf"),
    bold: resolve(root, "assets/fonts/NotoSans-Bold.ttf"),
  };
  return cachedFontPaths;
}

export interface RenderPdfOptions {
  /**
   * Override the font path lookup. Tests inject a stub.
   */
  fonts?: { regular: string; bold: string };
}

export async function renderReportPdf(
  markdown: string,
  options: RenderPdfOptions = {},
): Promise<Uint8Array> {
  const blocks = markdownToBlocks(markdown);
  return renderBlocksToPdf(blocks, options);
}

export async function renderBlocksToPdf(
  blocks: readonly Block[],
  options: RenderPdfOptions = {},
): Promise<Uint8Array> {
  const fonts = options.fonts ?? resolveFontPaths();
  const doc = new PDFDocument({
    size: [A4_WIDTH, A4_HEIGHT],
    margin: PAGE_MARGIN,
    info: { Title: "Brikell Property Intelligence Report" },
    bufferPages: true,
  });
  doc.registerFont(FONT_REGULAR, fonts.regular);
  doc.registerFont(FONT_BOLD, fonts.bold);
  doc.font(FONT_REGULAR).fontSize(11);

  for (const block of blocks) {
    renderBlock(doc, block);
  }

  addPageNumbers(doc);

  const chunks: Buffer[] = [];
  return new Promise((resolveResult, rejectResult) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => {
      const buffer = Buffer.concat(chunks);
      resolveResult(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
    });
    doc.on("error", rejectResult);
    doc.end();
  });
}

function renderBlock(doc: PDFKit.PDFDocument, block: Block): void {
  switch (block.kind) {
    case "heading":
      renderHeading(doc, block.level, block.spans);
      break;
    case "paragraph":
      renderParagraph(doc, block.spans);
      break;
    case "list":
      renderList(doc, block, 0);
      break;
    case "hr":
      renderHorizontalRule(doc);
      break;
    case "table":
      renderTable(doc, block);
      break;
    case "warning":
      // Warnings are dropped from the visible PDF (they're for internal logs).
      // Surface a tiny placeholder line in italics so the reader knows
      // something was omitted.
      renderParagraph(doc, [
        {
          text: `[unrendered ${block.reason.replace(/^unsupported_/, "")}]`,
          bold: false,
        },
      ]);
      break;
  }
}

function renderHeading(
  doc: PDFKit.PDFDocument,
  level: 1 | 2 | 3,
  spans: readonly TextSpan[],
): void {
  const sizes: Record<typeof level, number> = { 1: 22, 2: 16, 3: 13 };
  const spaceBefore: Record<typeof level, number> = { 1: 18, 2: 14, 3: 10 };
  doc.moveDown(spaceBefore[level] / 11);
  const startY = doc.y;
  doc.font(FONT_BOLD).fontSize(sizes[level]);
  writeSpansAsParagraph(doc, spans, true);
  doc.font(FONT_REGULAR).fontSize(11);
  // Subtle underline for h1 only.
  if (level === 1) {
    const endY = doc.y;
    doc
      .strokeColor("#888888")
      .lineWidth(0.5)
      .moveTo(PAGE_MARGIN, endY + 1)
      .lineTo(A4_WIDTH - PAGE_MARGIN, endY + 1)
      .stroke()
      .strokeColor("black")
      .lineWidth(1);
    doc.moveDown(0.2);
  }
  void startY;
}

function renderParagraph(doc: PDFKit.PDFDocument, spans: readonly TextSpan[]): void {
  doc.font(FONT_REGULAR).fontSize(11);
  writeSpansAsParagraph(doc, spans, true);
  doc.moveDown(0.4);
}

function renderList(doc: PDFKit.PDFDocument, list: Extract<Block, { kind: "list" }>, depth: number): void {
  doc.font(FONT_REGULAR).fontSize(11);
  const baseIndent = PAGE_MARGIN + depth * 16;
  for (let index = 0; index < list.items.length; index++) {
    const item = list.items[index];
    const bullet = list.ordered ? `${index + 1}.` : "•";
    doc.text(bullet, baseIndent, doc.y, { continued: false, lineBreak: false, width: 12 });
    // Move y back up so the bullet and item share a line.
    const bulletY = doc.y;
    doc.text("", baseIndent + 12, bulletY);
    writeSpansAsParagraph(doc, item.spans, true, { x: baseIndent + 16, width: A4_WIDTH - baseIndent - 16 - PAGE_MARGIN });
    if (item.children) {
      for (const child of item.children) renderList(doc, child, depth + 1);
    }
  }
  doc.moveDown(0.3);
}

function renderHorizontalRule(doc: PDFKit.PDFDocument): void {
  doc.moveDown(0.3);
  const y = doc.y + 4;
  doc
    .strokeColor("#cccccc")
    .lineWidth(0.5)
    .moveTo(PAGE_MARGIN, y)
    .lineTo(A4_WIDTH - PAGE_MARGIN, y)
    .stroke()
    .strokeColor("black")
    .lineWidth(1);
  doc.y = y + 6;
}

function renderTable(doc: PDFKit.PDFDocument, table: Extract<Block, { kind: "table" }>): void {
  doc.font(FONT_REGULAR).fontSize(10);
  doc.moveDown(0.3);
  const cols = Math.max(table.header.cells.length, ...table.rows.map((row) => row.cells.length));
  if (cols === 0) return;
  const usable = A4_WIDTH - 2 * PAGE_MARGIN;
  const colWidth = usable / cols;

  const drawRow = (cells: readonly (readonly TextSpan[])[], bold: boolean) => {
    const rowStartY = doc.y;
    let maxBottom = rowStartY;
    for (let col = 0; col < cols; col++) {
      const cellSpans = cells[col] ?? [];
      const x = PAGE_MARGIN + col * colWidth;
      doc.font(bold ? FONT_BOLD : FONT_REGULAR);
      const cellText = cellSpans.map((s) => s.text).join("");
      doc.text(cellText, x + 4, rowStartY + 2, { width: colWidth - 8 });
      if (doc.y > maxBottom) maxBottom = doc.y;
    }
    // Reset y to the bottom of the tallest cell + padding.
    doc.y = maxBottom + 4;
    doc.font(FONT_REGULAR);
    doc
      .strokeColor("#dddddd")
      .lineWidth(0.5)
      .moveTo(PAGE_MARGIN, doc.y)
      .lineTo(A4_WIDTH - PAGE_MARGIN, doc.y)
      .stroke()
      .strokeColor("black")
      .lineWidth(1);
    doc.y += 2;
  };

  drawRow(table.header.cells, true);
  for (const row of table.rows) drawRow(row.cells, false);
  doc.fontSize(11);
  doc.moveDown(0.3);
}

interface WriteOptions {
  x?: number;
  width?: number;
}

function writeSpansAsParagraph(
  doc: PDFKit.PDFDocument,
  spans: readonly TextSpan[],
  ensureFinalLineBreak: boolean,
  options: WriteOptions = {},
): void {
  if (spans.length === 0) {
    if (ensureFinalLineBreak) doc.moveDown(0.2);
    return;
  }
  const startX = options.x ?? PAGE_MARGIN;
  const width = options.width ?? A4_WIDTH - 2 * PAGE_MARGIN;
  const startY = doc.y;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const isLast = i === spans.length - 1;
    doc.font(span.bold ? FONT_BOLD : FONT_REGULAR);
    if (i === 0) {
      doc.text(span.text, startX, startY, { width, continued: !isLast });
    } else {
      doc.text(span.text, { width, continued: !isLast });
    }
  }
  doc.font(FONT_REGULAR);
}

function addPageNumbers(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const text = `Page ${i + 1} of ${range.count}`;
    doc
      .font(FONT_REGULAR)
      .fontSize(9)
      .fillColor("#888888")
      .text(text, PAGE_MARGIN, A4_HEIGHT - PAGE_MARGIN + 16, {
        width: A4_WIDTH - 2 * PAGE_MARGIN,
        align: "center",
        lineBreak: false,
      })
      .fillColor("black");
  }
}
