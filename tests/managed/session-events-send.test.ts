import assert from "node:assert/strict";
import { test } from "node:test";

import {
  sendSessionEventsWithTimeout,
  __test_only,
} from "../../src/agent/managed/session-events-send";

interface RecordedSendCall {
  sessionId: string;
  params: unknown;
  options: { timeout?: number; maxRetries?: number } | undefined;
}

function makeBeta(behavior: {
  fail?: () => Promise<never>;
  succeed?: boolean;
  hangs?: boolean;
}): { beta: Parameters<typeof sendSessionEventsWithTimeout>[0]; calls: RecordedSendCall[] } {
  const calls: RecordedSendCall[] = [];
  const sendImpl = async (sessionId: string, params: unknown, options?: { timeout?: number; maxRetries?: number }) => {
    calls.push({ sessionId, params, options });
    if (behavior.fail) return behavior.fail();
    if (behavior.hangs) return await new Promise<never>(() => {});
    return Promise.resolve(undefined);
  };
  return {
    beta: {
      sessions: {
        events: {
          // The helper ignores stream/list; only send is exercised here.
          stream: async () => {
            throw new Error("stream() should not be called by sendSessionEventsWithTimeout");
          },
          list() {
            return (async function* () {
              throw new Error("list() should not be called by sendSessionEventsWithTimeout");
            })();
          },
          send: sendImpl,
        },
      },
    } as unknown as Parameters<typeof sendSessionEventsWithTimeout>[0],
    calls,
  };
}

test("user-message: passes timeoutMs and maxRetries=0 by default to the SDK", async () => {
  const { beta, calls } = makeBeta({ succeed: true });
  await sendSessionEventsWithTimeout(beta, "sess-1", { events: [{ type: "user.message" }] }, {
    kind: "user-message",
    log: () => {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sessionId, "sess-1");
  assert.equal(calls[0]!.options?.timeout, __test_only.DEFAULT_TIMEOUT_MS);
  assert.equal(calls[0]!.options?.maxRetries, __test_only.DEFAULT_USER_MESSAGE_MAX_RETRIES);
});

test("tool-result: passes timeoutMs and maxRetries=2 by default to the SDK", async () => {
  const { beta, calls } = makeBeta({ succeed: true });
  await sendSessionEventsWithTimeout(beta, "sess-1", { events: [{ type: "user.custom_tool_result" }] }, {
    kind: "tool-result",
    log: () => {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options?.timeout, __test_only.DEFAULT_TIMEOUT_MS);
  assert.equal(calls[0]!.options?.maxRetries, __test_only.DEFAULT_TOOL_RESULT_MAX_RETRIES);
});

test("explicit timeoutMs/maxRetries override env defaults", async () => {
  const { beta, calls } = makeBeta({ succeed: true });
  await sendSessionEventsWithTimeout(beta, "sess-1", { events: [] }, {
    kind: "tool-result",
    timeoutMs: 5_000,
    maxRetries: 7,
    log: () => {},
  });
  assert.equal(calls[0]!.options?.timeout, 5_000);
  assert.equal(calls[0]!.options?.maxRetries, 7);
});

test("env vars override defaults", async () => {
  const prevTimeout = process.env.MANAGED_AGENT_EVENTS_SEND_TIMEOUT_MS;
  const prevMaxRetries = process.env.MANAGED_AGENT_EVENTS_SEND_TOOL_RESULT_MAX_RETRIES;
  process.env.MANAGED_AGENT_EVENTS_SEND_TIMEOUT_MS = "12345";
  process.env.MANAGED_AGENT_EVENTS_SEND_TOOL_RESULT_MAX_RETRIES = "5";
  try {
    const { beta, calls } = makeBeta({ succeed: true });
    await sendSessionEventsWithTimeout(beta, "sess-1", { events: [] }, {
      kind: "tool-result",
      log: () => {},
    });
    assert.equal(calls[0]!.options?.timeout, 12345);
    assert.equal(calls[0]!.options?.maxRetries, 5);
  } finally {
    if (prevTimeout === undefined) delete process.env.MANAGED_AGENT_EVENTS_SEND_TIMEOUT_MS;
    else process.env.MANAGED_AGENT_EVENTS_SEND_TIMEOUT_MS = prevTimeout;
    if (prevMaxRetries === undefined) delete process.env.MANAGED_AGENT_EVENTS_SEND_TOOL_RESULT_MAX_RETRIES;
    else process.env.MANAGED_AGENT_EVENTS_SEND_TOOL_RESULT_MAX_RETRIES = prevMaxRetries;
  }
});

test("on SDK error, throws a clean error including the original cause", async () => {
  const sdkError = new Error("Connection error.");
  sdkError.name = "APIConnectionError";
  const { beta } = makeBeta({ fail: () => Promise.reject(sdkError) });
  await assert.rejects(
    () =>
      sendSessionEventsWithTimeout(beta, "sess-1", { events: [] }, {
        kind: "tool-result",
        contextLog: { customToolUseId: "cuid-1" },
        log: () => {},
      }),
    (error: Error) => {
      // Helper-level error includes session, timeout, retries, original message.
      assert.match(error.message, /sess-1/);
      assert.match(error.message, /tool-result/);
      assert.match(error.message, /Connection error\./);
      assert.equal((error as Error & { cause?: unknown }).cause, sdkError);
      return true;
    },
  );
});

test("logs start AND failure when SDK throws", async () => {
  const logged: { message: string; payload?: Record<string, unknown> }[] = [];
  const sdkError = new Error("boom");
  const { beta } = makeBeta({ fail: () => Promise.reject(sdkError) });
  await assert.rejects(() =>
    sendSessionEventsWithTimeout(beta, "sess-1", { events: [] }, {
      kind: "tool-result",
      contextLog: { customToolUseId: "cuid-1", toolName: "datafordeler.lookup" },
      log: (message, payload) => logged.push({ message, payload }),
    }),
  );
  // Two log lines: start + failure
  assert.equal(logged.length, 2);
  assert.equal(logged[0]!.message, "events.send start");
  assert.equal(logged[0]!.payload?.kind, "tool-result");
  assert.equal(logged[0]!.payload?.customToolUseId, "cuid-1");
  assert.equal(logged[0]!.payload?.toolName, "datafordeler.lookup");
  assert.equal(logged[1]!.message, "events.send failed");
  assert.match(String(logged[1]!.payload?.error), /boom/);
});

test("logs start when send succeeds (no failure log)", async () => {
  const logged: { message: string }[] = [];
  const { beta } = makeBeta({ succeed: true });
  await sendSessionEventsWithTimeout(beta, "sess-1", { events: [] }, {
    kind: "tool-result",
    log: (message) => logged.push({ message }),
  });
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.message, "events.send start");
});
