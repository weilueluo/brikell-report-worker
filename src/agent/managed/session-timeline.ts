import { sanitizeEventPayload } from "./structured-events";

export type ManagedSessionTimelineKind =
  | "agent"
  | "error"
  | "event"
  | "idle"
  | "model"
  | "result"
  | "running"
  | "thinking"
  | "tool"
  | "user";

export type ManagedSessionTimelineEntry = {
  kind: ManagedSessionTimelineKind;
  message: string;
  details?: unknown;
  elapsedMs?: number;
};

export type ManagedSessionTimelineFormatOptions = {
  columns?: number;
  maxMessageChars?: number;
  maxPayloadChars?: number;
};

const DEFAULT_COLUMNS = 100;
const DEFAULT_MAX_PAYLOAD_CHARS = 180;
const LABEL_COLUMN_WIDTH = 12;
const MIN_MESSAGE_CHARS = 24;

const TIMELINE_LABELS: Record<ManagedSessionTimelineKind, string> = {
  agent: "Agent",
  error: "Error",
  event: "Event",
  idle: "Idle",
  model: "Model",
  result: "Result",
  running: "Running",
  thinking: "Thinking",
  tool: "Tool",
  user: "User",
};

export function formatElapsedDuration(elapsedMs: number): string {
  const safeElapsedMs = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const totalSeconds = Math.floor(safeElapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatInlineText(value: string, maxChars: number): string {
  const inline = value.replace(/\s+/g, " ").trim();
  if (inline.length <= maxChars) return inline;
  if (maxChars <= 3) return ".".repeat(Math.max(0, maxChars));
  return `${inline.slice(0, maxChars - 3)}...`;
}

export function formatTimelinePayload(payload: unknown, maxChars = DEFAULT_MAX_PAYLOAD_CHARS): string {
  if (payload === undefined || payload === "") return "";

  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return "";

    const parsed = tryParseJsonPayload(trimmed);
    if (parsed.ok) {
      return formatInlineText(JSON.stringify(sanitizeEventPayload(parsed.value)) ?? "", maxChars);
    }

    return formatInlineText(String(sanitizeEventPayload(trimmed)), maxChars);
  }

  const sanitized = sanitizeEventPayload(payload);
  return formatInlineText(JSON.stringify(sanitized) ?? String(sanitized), maxChars);
}

export function formatSessionTimelineEntry(
  entry: ManagedSessionTimelineEntry,
  options: ManagedSessionTimelineFormatOptions = {},
): string {
  const label = `[${TIMELINE_LABELS[entry.kind]}]`.padEnd(LABEL_COLUMN_WIDTH);
  const payload = formatTimelinePayload(entry.details, options.maxPayloadChars);
  const rawMessage = payload ? `${entry.message} ${payload}` : entry.message;
  const elapsed = entry.elapsedMs === undefined ? "" : formatElapsedDuration(entry.elapsedMs);
  const columns = normalizeColumns(options.columns);
  const availableMessageChars = elapsed
    ? columns - LABEL_COLUMN_WIDTH - elapsed.length - 2
    : columns - LABEL_COLUMN_WIDTH - 1;
  const maxMessageChars = options.maxMessageChars ?? Math.max(MIN_MESSAGE_CHARS, availableMessageChars);
  const message = formatInlineText(rawMessage, maxMessageChars);
  const rowStart = `${label} ${message}`;

  if (!elapsed) return rowStart;

  const gap = Math.max(1, columns - rowStart.length - elapsed.length);
  return `${rowStart}${" ".repeat(gap)}${elapsed}`;
}

function normalizeColumns(columns: number | undefined): number {
  if (columns === undefined || !Number.isFinite(columns) || columns < 1) return DEFAULT_COLUMNS;
  return Math.floor(columns);
}

function tryParseJsonPayload(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!/^[{\[]/.test(text)) return { ok: false };

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
