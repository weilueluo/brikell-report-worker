const SENSITIVE_KEY_PATTERN = /authorization|cookie|token|secret|password|credential|api[-_]?key/i;
const SENSITIVE_TEXT_PATTERN =
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+|(bearer\s+)[^\s,;]+|((?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi;
const DEFAULT_MAX_EVENT_CHARS = 8_000;

export function sanitizeEventPayload(value: unknown, maxChars = DEFAULT_MAX_EVENT_CHARS): unknown {
  const sanitized = sanitize(value, new WeakSet<object>());
  const text = JSON.stringify(sanitized);
  if (text.length <= maxChars) return sanitized;
  return {
    truncated: true,
    originalChars: text.length,
    excerpt: text.slice(0, maxChars),
  };
}

export function structuredEvent(name: string, payload: unknown = {}): string {
  return `${JSON.stringify({
    event: name,
    ts: new Date().toISOString(),
    payload: sanitizeEventPayload(payload),
  })}\n`;
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return value.replace(
      SENSITIVE_TEXT_PATTERN,
      (_match, authorizationBearerPrefix, bearerPrefix, keyPrefix) =>
        `${authorizationBearerPrefix ?? bearerPrefix ?? keyPrefix ?? ""}[redacted]`,
    );
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, seen));

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitize(nested, seen);
  }
  return output;
}
