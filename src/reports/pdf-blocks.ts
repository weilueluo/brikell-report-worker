import { marked } from "marked";

/**
 * Shared block model for the PDF renderer.
 *
 * Why this exists:
 * - `marked` produces a rich AST that's a superset of what we render
 * - pdfkit needs a small set of layout primitives (heading/paragraph/list/hr)
 * - We deliberately drop tokens we cannot render (tables, code fences, deep
 *   nesting). Those become `warning` blocks so they're visible at test time
 *   and surface in logs, without crashing the renderer.
 *
 * Why a single shared block model:
 * - Canonical V1 → markdown via `renderReportV1Markdown` → blocks (one path)
 * - Agent free-text markdown → blocks (same path)
 * - The PDF renderer never branches on the source.
 */

export interface TextSpan {
  readonly text: string;
  readonly bold: boolean;
}

export interface HeadingBlock {
  readonly kind: "heading";
  readonly level: 1 | 2 | 3;
  readonly spans: readonly TextSpan[];
}

export interface ParagraphBlock {
  readonly kind: "paragraph";
  readonly spans: readonly TextSpan[];
}

export interface ListItemNode {
  readonly spans: readonly TextSpan[];
  /**
   * Nested sublists. Rendered indented under the parent item.
   */
  readonly children?: readonly ListBlock[];
}

export interface ListBlock {
  readonly kind: "list";
  readonly ordered: boolean;
  readonly items: readonly ListItemNode[];
}

export interface HorizontalRuleBlock {
  readonly kind: "hr";
}

export type WarningReason =
  | "unsupported_table"
  | "unsupported_code"
  | "unsupported_blockquote"
  | "unsupported_html"
  | "unsupported_image"
  | "unsupported_other";

export interface WarningBlock {
  readonly kind: "warning";
  readonly reason: WarningReason;
  readonly detail?: string;
}

export interface TableRow {
  readonly cells: readonly (readonly TextSpan[])[];
}

export interface TableBlock {
  readonly kind: "table";
  readonly header: TableRow;
  readonly rows: readonly TableRow[];
}

export type Block = HeadingBlock | ParagraphBlock | ListBlock | HorizontalRuleBlock | TableBlock | WarningBlock;

interface MarkedToken {
  type: string;
  raw?: string;
  text?: string;
  depth?: number;
  ordered?: boolean;
  items?: MarkedToken[];
  tokens?: MarkedToken[];
  header?: { tokens?: MarkedToken[]; text?: string }[];
  rows?: { tokens?: MarkedToken[]; text?: string }[][];
}

/**
 * Convert a markdown string into the supported block subset. Never throws;
 * unsupported nodes become `warning` blocks.
 */
export function markdownToBlocks(markdown: string): Block[] {
  if (!markdown || markdown.trim().length === 0) return [];
  const tokens = marked.lexer(markdown) as MarkedToken[];
  const blocks: Block[] = [];
  for (const token of tokens) {
    const block = tokenToBlock(token);
    if (block) blocks.push(...block);
  }
  return blocks;
}

function tokenToBlock(token: MarkedToken): Block[] | undefined {
  switch (token.type) {
    case "space":
      return undefined;
    case "heading": {
      const level = clampHeadingLevel(token.depth);
      const spans = inlineSpans(token.tokens ?? [{ type: "text", text: token.text ?? "" } as MarkedToken]);
      return [{ kind: "heading", level, spans }];
    }
    case "paragraph": {
      const spans = inlineSpans(token.tokens ?? [{ type: "text", text: token.text ?? "" } as MarkedToken]);
      return [{ kind: "paragraph", spans }];
    }
    case "list": {
      const items = (token.items ?? []).map<ListItemNode>((item) => {
        const subTokens = item.tokens ?? [];
        const inlineTokens = subTokens.filter((sub) => sub.type !== "list");
        const childListTokens = subTokens.filter((sub) => sub.type === "list");
        const children: ListBlock[] = [];
        for (const childToken of childListTokens) {
          const blocks = tokenToBlock(childToken);
          if (blocks) {
            for (const block of blocks) {
              if (block.kind === "list") children.push(block);
            }
          }
        }
        return {
          spans: inlineSpans(inlineTokens),
          ...(children.length > 0 ? { children } : {}),
        };
      });
      return [{ kind: "list", ordered: Boolean(token.ordered), items }];
    }
    case "hr":
      return [{ kind: "hr" }];
    case "code":
      return [{ kind: "warning", reason: "unsupported_code", detail: truncate(token.text ?? token.raw ?? "", 80) }];
    case "table": {
      const headerCells = (token.header ?? []).map((cell) =>
        cell.tokens ? inlineSpans(cell.tokens) : [{ text: cell.text ?? "", bold: true } as TextSpan],
      );
      const bodyRows = (token.rows ?? []).map((row) => ({
        cells: row.map((cell) =>
          cell.tokens ? inlineSpans(cell.tokens) : [{ text: cell.text ?? "", bold: false } as TextSpan],
        ),
      }));
      return [
        {
          kind: "table",
          header: { cells: headerCells },
          rows: bodyRows,
        },
      ];
    }
    case "blockquote":
      return [{ kind: "warning", reason: "unsupported_blockquote" }];
    case "html":
      return [{ kind: "warning", reason: "unsupported_html" }];
    default:
      return [{ kind: "warning", reason: "unsupported_other", detail: token.type }];
  }
}

function inlineSpans(tokens: readonly MarkedToken[]): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const token of tokens) collectInline(token, false, spans);
  return mergeAdjacentSpans(spans);
}

function collectInline(token: MarkedToken, bold: boolean, out: TextSpan[]): void {
  switch (token.type) {
    case "text":
      // marked emits 'text' tokens with nested 'tokens' for inline content
      // (e.g. bold inside a list item). Recurse into them; otherwise treat as a leaf.
      if (token.tokens && token.tokens.length > 0) {
        for (const child of token.tokens) collectInline(child, bold, out);
      } else if (token.text) {
        out.push({ text: token.text, bold });
      }
      break;
    case "strong":
      for (const child of token.tokens ?? []) collectInline(child, true, out);
      break;
    case "em":
      // Italic isn't supported as a separate style; render as bold for emphasis.
      for (const child of token.tokens ?? []) collectInline(child, true, out);
      break;
    case "codespan":
      // Inline code rendered as plain text; we don't have a monospace style yet.
      if (token.text) out.push({ text: token.text, bold });
      break;
    case "link":
      // Render the link's text only; the URL is not visible in PDF.
      for (const child of token.tokens ?? []) collectInline(child, bold, out);
      break;
    case "image":
      // Images dropped; surface as text alt placeholder only.
      if (token.text) out.push({ text: `[image: ${token.text}]`, bold });
      break;
    case "br":
      out.push({ text: "\n", bold });
      break;
    case "html":
      // Inline HTML (like <br>) — drop silently.
      break;
    default:
      if (token.text) out.push({ text: token.text, bold });
      break;
  }
}

function mergeAdjacentSpans(spans: TextSpan[]): TextSpan[] {
  const out: TextSpan[] = [];
  for (const span of spans) {
    if (span.text === "") continue;
    const last = out[out.length - 1];
    if (last && last.bold === span.bold) {
      out[out.length - 1] = { text: last.text + span.text, bold: last.bold };
    } else {
      out.push(span);
    }
  }
  return out;
}

function clampHeadingLevel(depth: number | undefined): 1 | 2 | 3 {
  if (depth === 1) return 1;
  if (depth === 2) return 2;
  return 3; // collapse h4-h6 into h3
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
