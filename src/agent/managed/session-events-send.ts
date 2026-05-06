/**
 * Per-call timeout wrapper for `beta.sessions.events.send`.
 *
 * Why this exists:
 * The bridge processes Anthropic session events serially in a for-await loop.
 * For each event that requires a response (datasource tool result, initial
 * user.message at boot) the loop awaits
 * `beta.sessions.events.send`. The Anthropic SDK's per-call timeout defaults
 * to the client-level setting (currently 30 minutes). If a single send hangs
 * — network deadlock, dispatcher resource starvation, transient routing
 * issue — the whole bridge stalls for up to 30 minutes before any timeout
 * fires. The 45-minute overall watchdog catches it eventually but that's far
 * too long for what should be a sub-second POST.
 *
 * Design:
 * Use the SDK's `timeout` option (NOT a custom AbortSignal). The SDK retries
 * its own timeout-aborts on connection / 429 / 5xx errors per `maxRetries`,
 * so passing `timeout: 30_000` gives us ~30s × (maxRetries + 1) total budget
 * before the helper throws.
 *
 * Per-kind retry policy:
 * - `user-message`: maxRetries=0. There is no idempotency contract on this
 *   endpoint in SDK 0.91.1 — duplicating the initial user.message could fork
 *   the session. Better to fail fast than risk a duplicate prompt.
 * - `tool-result`: SDK default (maxRetries=2). The agent waits on a single
 *   tool result keyed by `custom_tool_use_id`; the worst-case duplicate sends
 *   to the same id are accepted (the second is recorded but ignored — agent
 *   has already moved on). Failing fast here means the run dies with a clear
 *   error, the user retries; better than a 30+ minute silent hang.
 *
 * The helper logs every attempt so prod logs surface the issue immediately
 * instead of going quiet for tens of minutes.
 */

import type { BetaSessionsLike } from "./session-stream-resilience";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_RESULT_MAX_RETRIES = 2;
const DEFAULT_USER_MESSAGE_MAX_RETRIES = 0;

export type SessionSendKind = "user-message" | "tool-result";

export interface SendSessionEventsOptions {
  kind: SessionSendKind;
  /** Optional context for log messages — e.g., `custom_tool_use_id` or tool name. */
  contextLog?: Record<string, unknown>;
  /** Override defaults; tests inject these. */
  timeoutMs?: number;
  maxRetries?: number;
  /** Logger; defaults to console.warn for visibility. */
  log?: (message: string, payload?: Record<string, unknown>) => void;
}

interface AnthropicSdkRequestOptions {
  timeout?: number;
  maxRetries?: number;
}

interface BetaWithSendableEvents extends BetaSessionsLike {
  sessions: BetaSessionsLike["sessions"] & {
    events: BetaSessionsLike["sessions"]["events"] & {
      send: (
        sessionId: string,
        params: unknown,
        options?: AnthropicSdkRequestOptions,
      ) => Promise<unknown>;
    };
  };
}

function readPositiveInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultLog(message: string, payload?: Record<string, unknown>): void {
  if (payload && Object.keys(payload).length > 0) {
    console.warn(`[managed-runner] ${message}`, payload);
  } else {
    console.warn(`[managed-runner] ${message}`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Send session events with a bounded per-call timeout. Throws a clear error if
 * all attempts fail; never silently waits 30 minutes.
 */
export async function sendSessionEventsWithTimeout(
  beta: BetaSessionsLike,
  sessionId: string,
  params: unknown,
  options: SendSessionEventsOptions,
): Promise<void> {
  const log = options.log ?? defaultLog;
  const timeoutMs =
    options.timeoutMs ?? readPositiveInt("MANAGED_AGENT_EVENTS_SEND_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const defaultMaxRetries =
    options.kind === "user-message"
      ? readPositiveInt(
          "MANAGED_AGENT_EVENTS_SEND_USER_MESSAGE_MAX_RETRIES",
          DEFAULT_USER_MESSAGE_MAX_RETRIES,
        )
      : readPositiveInt(
          "MANAGED_AGENT_EVENTS_SEND_TOOL_RESULT_MAX_RETRIES",
          DEFAULT_TOOL_RESULT_MAX_RETRIES,
        );
  const maxRetries = options.maxRetries ?? defaultMaxRetries;

  const sendable = beta as BetaWithSendableEvents;
  log("events.send start", {
    kind: options.kind,
    sessionId,
    timeoutMs,
    maxRetries,
    ...options.contextLog,
  });

  try {
    await sendable.sessions.events.send(sessionId, params, {
      timeout: timeoutMs,
      maxRetries,
    });
  } catch (error) {
    log("events.send failed", {
      kind: options.kind,
      sessionId,
      timeoutMs,
      maxRetries,
      error: errorMessage(error),
      ...options.contextLog,
    });
    throw new Error(
      `beta.sessions.events.send (${options.kind}) failed for session ${sessionId} after timeout=${timeoutMs}ms maxRetries=${maxRetries}: ${errorMessage(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

export const __test_only = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOOL_RESULT_MAX_RETRIES,
  DEFAULT_USER_MESSAGE_MAX_RETRIES,
};
