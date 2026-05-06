import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, test } from "node:test";

import {
  __resetManagedAgentFetchAgentForTests,
  buildLongLivedFetch,
  getManagedAgentFetchLoadError,
  getManagedAgentFetchPath,
  getManagedAgentUndiciVersion,
  managedAgentDispatcherDefaults,
  primeManagedAgentDispatcher,
} from "../../src/agent/managed/streaming-fetch";

const require = createRequire(import.meta.url);

afterEach(() => {
  __resetManagedAgentFetchAgentForTests();
});

test("managedAgentDispatcherDefaults disables body timeout but bounds handshake and idle", () => {
  // bodyTimeout MUST be 0 — the SSE channel goes silent for many minutes during
  // server-side tool calls, and Node's default 5-min cap kills those runs.
  assert.equal(managedAgentDispatcherDefaults.bodyTimeout, 0);
  // headersTimeout must be finite — a stuck handshake should be aborted.
  assert.ok(managedAgentDispatcherDefaults.headersTimeout > 0);
  assert.ok(Number.isFinite(managedAgentDispatcherDefaults.headersTimeout));
  // keepAliveTimeout > 0 keeps idle sockets warm without indefinite pinning.
  assert.ok(managedAgentDispatcherDefaults.keepAliveTimeout > 0);
});

test("buildLongLivedFetch routes through the injected dispatcher's fetch + agent", async () => {
  const calls: Array<{ input: unknown; init?: RequestInit & { dispatcher?: unknown } }> = [];
  const fakeAgent = { tag: "fake-agent" };
  const fakeUndiciFetch: typeof fetch = async (input, init) => {
    calls.push({ input, init: init as RequestInit & { dispatcher?: unknown } });
    return new Response("ok", { status: 200 });
  };
  const longLivedFetch = buildLongLivedFetch({
    loadDispatcher: () => ({ fetch: fakeUndiciFetch, agent: fakeAgent as unknown as never }),
    fallbackFetch: async () => new Response("FALLBACK") as Response,
    onLoadFailure: () => {
      throw new Error("onLoadFailure should not fire when the dispatcher loads");
    },
  });

  const response = await longLivedFetch("https://example.test/", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input, "https://example.test/");
  assert.equal((calls[0]!.init as Record<string, unknown>).dispatcher, fakeAgent);
  assert.equal((calls[0]!.init as RequestInit).method, "POST");
});

test("buildLongLivedFetch falls back to globalThis.fetch when the dispatcher cannot load", async () => {
  let fallbackCalls = 0;
  const fallbackFetch: typeof fetch = async () => {
    fallbackCalls++;
    return new Response("fallback") as Response;
  };
  const failures: unknown[] = [];
  const longLivedFetch = buildLongLivedFetch({
    loadDispatcher: () => undefined,
    fallbackFetch,
    onLoadFailure: (cause) => {
      failures.push(cause);
    },
  });

  const r1 = await longLivedFetch("https://example.test/a");
  const r2 = await longLivedFetch("https://example.test/b");
  assert.equal(await r1.text(), "fallback");
  assert.equal(await r2.text(), "fallback");
  assert.equal(fallbackCalls, 2);
  // onLoadFailure must fire AT MOST ONCE per built fetch, even after many calls.
  assert.equal(failures.length, 1);
});

test("buildLongLivedFetch swallows a throwing loadDispatcher and uses the fallback", async () => {
  let fallbackCalls = 0;
  const longLivedFetch = buildLongLivedFetch({
    loadDispatcher: () => {
      throw new Error("simulated loader crash");
    },
    fallbackFetch: async () => {
      fallbackCalls++;
      return new Response("ok") as Response;
    },
    onLoadFailure: () => {},
  });

  const response = await longLivedFetch("https://example.test/");
  assert.equal(response.status, 200);
  assert.equal(fallbackCalls, 1);
  // The captured load error from the throwing loader should be visible.
  const err = getManagedAgentFetchLoadError();
  assert.ok(err instanceof Error);
  assert.match((err as Error).message, /simulated loader crash/);
});

test("buildLongLivedFetch does not overwrite a caller-provided dispatcher", async () => {
  const dispatcherFromTest = { id: "caller-dispatcher" };
  const dispatcherFromLoader = { id: "loader-dispatcher" };
  let observedDispatcher: unknown;
  const fakeUndiciFetch: typeof fetch = async (_input, init) => {
    observedDispatcher = (init as RequestInit & { dispatcher?: unknown }).dispatcher;
    return new Response("ok") as Response;
  };
  const longLivedFetch = buildLongLivedFetch({
    loadDispatcher: () => ({ fetch: fakeUndiciFetch, agent: dispatcherFromLoader as unknown as never }),
  });

  await longLivedFetch("https://example.test/", { dispatcher: dispatcherFromTest } as RequestInit & {
    dispatcher: unknown;
  });
  assert.equal(observedDispatcher, dispatcherFromTest);
});

test("getManagedAgentFetchPath reports uninitialized before priming and a final state after", () => {
  __resetManagedAgentFetchAgentForTests();
  assert.equal(getManagedAgentFetchPath(), "uninitialized");
  primeManagedAgentDispatcher();
  // Either path is acceptable depending on whether undici is loadable in the
  // current process; we just need it to NOT remain "uninitialized".
  assert.notEqual(getManagedAgentFetchPath(), "uninitialized");
});

test("primeManagedAgentDispatcher is idempotent", () => {
  __resetManagedAgentFetchAgentForTests();
  primeManagedAgentDispatcher();
  const firstPath = getManagedAgentFetchPath();
  const firstVersion = getManagedAgentUndiciVersion();
  primeManagedAgentDispatcher();
  primeManagedAgentDispatcher();
  assert.equal(getManagedAgentFetchPath(), firstPath);
  assert.equal(getManagedAgentUndiciVersion(), firstVersion);
});

test("primeManagedAgentDispatcher with a real undici module reports npm-undici and a version string", () => {
  __resetManagedAgentFetchAgentForTests();
  // The report-app declares undici as a direct dep; require should succeed in
  // the test runtime. If a future change drops undici this test will become
  // a regression signal that the resilience path is no longer wired.
  primeManagedAgentDispatcher();
  assert.equal(getManagedAgentFetchPath(), "npm-undici");
  const version = getManagedAgentUndiciVersion();
  assert.equal(typeof version, "string");
  assert.match(version!, /^\d+\.\d+\.\d+/);
});

test("priming aligns globalThis.FormData/File/Response with npm undici (Anthropic SDK upload check)", async () => {
  __resetManagedAgentFetchAgentForTests();
  primeManagedAgentDispatcher();
  // Replicate the Anthropic SDK's own supportsFormData() check from
  // node_modules/@anthropic-ai/sdk/internal/uploads.ts. Without globals
  // aligned, npm undici's Response receives a Node-built-in FormData and
  // can't read the multipart back, so data.toString() === Response.text().
  // With globals aligned, the round-trip works and the strings differ.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const undiciFetch = (require("undici") as { fetch: typeof fetch }).fetch;
  const sample = new FormData();
  sample.append("k", "v");
  const FetchResponse =
    "Response" in undiciFetch
      ? (undiciFetch as unknown as { Response: typeof Response }).Response
      : ((await undiciFetch("data:,")).constructor as typeof Response);
  const roundTripped = await new FetchResponse(sample).text();
  // If the globals weren't aligned the multipart would degenerate to
  // "[object FormData]" and equal sample.toString().
  assert.notEqual(roundTripped, sample.toString());
});
