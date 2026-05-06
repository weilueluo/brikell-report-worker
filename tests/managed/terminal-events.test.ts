import assert from "node:assert/strict";
import { test } from "node:test";

import { isRealTerminalSessionEvent } from "../../src/agent/managed/terminal-events";

test("session.status_terminated is terminal", () => {
  assert.equal(isRealTerminalSessionEvent({ type: "session.status_terminated" }), true);
});

test("session.status_idle with stop_reason=end_turn is terminal", () => {
  assert.equal(
    isRealTerminalSessionEvent({
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    }),
    true,
  );
});

test("session.status_idle with stop_reason=retries_exhausted is terminal", () => {
  assert.equal(
    isRealTerminalSessionEvent({
      type: "session.status_idle",
      stop_reason: { type: "retries_exhausted" },
    }),
    true,
  );
});

test("session.status_idle with stop_reason=requires_action is NOT terminal", () => {
  // Core invariant: agent is paused waiting for tool results, will resume.
  assert.equal(
    isRealTerminalSessionEvent({
      type: "session.status_idle",
      stop_reason: { type: "requires_action" },
    }),
    false,
  );
});

test("session.status_idle without stop_reason defaults to terminal", () => {
  // Defensive: missing/unknown stop_reason is treated as terminal so the
  // bridge cleanly exits rather than polling forever on a malformed event.
  assert.equal(isRealTerminalSessionEvent({ type: "session.status_idle" }), true);
});

test("non-status events are never terminal", () => {
  for (const type of [
    "agent.message",
    "agent.thinking",
    "agent.custom_tool_use",
    "agent.tool_use",
    "agent.tool_result",
    "user.custom_tool_result",
    "session.status_running",
    "session.thread_status_idle",
    "span.model_request_start",
    "span.model_request_end",
  ]) {
    assert.equal(
      isRealTerminalSessionEvent({ type }),
      false,
      `${type} should not be terminal`,
    );
  }
});

test("null/undefined/non-object inputs are not terminal", () => {
  assert.equal(isRealTerminalSessionEvent(null), false);
  assert.equal(isRealTerminalSessionEvent(undefined), false);
  assert.equal(isRealTerminalSessionEvent("session.status_idle"), false);
  assert.equal(isRealTerminalSessionEvent(42), false);
});
