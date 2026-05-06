/**
 * Shared terminal-event predicate for managed-agent session events.
 *
 * The Anthropic SDK declares `session.status_idle.stop_reason` as exactly
 *   `end_turn | requires_action | retries_exhausted`
 * (see node_modules/@anthropic-ai/sdk/resources/beta/sessions/events.d.ts).
 *
 * For our bridge:
 *   - `session.status_terminated`                       => terminal (session over)
 *   - `session.status_idle` + stop_reason `end_turn`    => terminal (turn done)
 *   - `session.status_idle` + stop_reason `retries_exhausted` => terminal (gave up)
 *   - `session.status_idle` + stop_reason `requires_action`   => NOT terminal
 *     (agent paused, awaiting tool results — bridge must respond and the
 *      session will resume)
 *
 * Used in two places:
 *   1. `session-stream-resilience.ts` — Phase 1 must NOT exit on a non-terminal
 *      idle (clean SSE EOF + non-terminal => fall through to Phase 2 polling);
 *      Phase 2 must NOT exit on a non-terminal idle either.
 *   2. `runner.ts` — outer for-await must NOT break on a non-terminal idle; the
 *      bridge needs to keep iterating after sending the tool result so it can
 *      see the agent's resumed events.
 *
 * Sharing the predicate keeps the two layers from drifting; a future stop_reason
 * variant gets the right treatment in both places by editing one helper.
 */

export interface SessionEventLike {
  type?: string;
  stop_reason?: { type?: string };
}

/**
 * `true` when the event signals the session has truly ended for this turn —
 * agent done, retries exhausted, or session terminated. Idle-with-requires-action
 * is `false` because the agent will resume after the bridge sends tool results.
 */
export function isRealTerminalSessionEvent(event: unknown): boolean {
  const evt = event as SessionEventLike | null | undefined;
  if (!evt || typeof evt !== "object") return false;
  if (evt.type === "session.status_terminated") return true;
  if (evt.type !== "session.status_idle") return false;
  const stopReasonType = evt.stop_reason?.type;
  // Defensive default: if stop_reason is missing or unknown, treat as terminal
  // (matches the legacy behavior — better to over-terminate cleanly than to
  // poll forever on a malformed event).
  if (!stopReasonType) return true;
  return stopReasonType !== "requires_action";
}
