import { createRequire } from "node:module";
import type { Agent as UndiciAgent } from "undici";

const require = createRequire(import.meta.url);

/**
 * Long-lived fetch for the Anthropic managed-agent SSE stream.
 *
 * Why this exists:
 * The managed-agent session stream stays open for the full duration of an
 * agent run. During multi-minute server-side tool execution the SSE channel
 * sends no body data; Node's built-in undici defaults to a 5-minute
 * `bodyTimeout` and forcibly terminates the socket with `TypeError: terminated`
 * (see run-2026-05-02T18-41-28-196Z.log: 5.4 min wall-clock to failure).
 *
 * Why not patch globalThis.fetch:
 * `globalThis.fetch` and `npm undici` are different module instances of undici.
 * Passing an `Agent` from npm undici to Node's built-in fetch as `dispatcher`
 * fails with `TypeError: fetch failed` because internal class identities don't
 * match. `setGlobalDispatcher` from npm undici similarly does not affect
 * Node's built-in fetch (Node initializes its own dispatcher at startup;
 * tracked in https://github.com/nodejs/node/issues/45674).
 *
 * Fix:
 * Use **npm undici's `fetch` end-to-end** for managed-agent calls only. The
 * Anthropic SDK accepts a custom `fetch` option, so we pass npm undici's fetch
 * (bound to a long-lived `Agent` with `bodyTimeout: 0`). Node's built-in fetch
 * is bypassed only on this code path; nothing else in the app changes.
 *
 * Why we also patch globalThis.{FormData,File,Blob,Response,Headers,Request}:
 * The Anthropic SDK builds upload bodies with `new FormData()` (globalThis's,
 * from Node's BUILT-IN undici) and then asks our custom fetch's `Response`
 * (NPM undici's) to read them back. Different module instances, different
 * internal class identities; the SDK's `supportsFormData` self-check fails
 * with "The provided fetch function does not support file uploads with the
 * current global FormData class." and skill upload (beta.skills.create) dies
 * before the agent can run. Replacing globalThis with NPM undici's variants
 * makes the SDK's FormData and our fetch's Response come from the same
 * module, so the check passes. Idempotent + safe — Node's built-in classes
 * and NPM undici's are spec-compatible.
 *
 * Defensive fallback:
 * If `require("undici")` fails (bundler stripped the module, missing native
 * binding, etc.) we fall back to `globalThis.fetch` and emit a structured
 * console.error so the operator notices. Worst case is the original 5-min
 * behavior — never a hard connection failure.
 *
 * This module owns connection-resilience for the managed-agent client only.
 * Per AGENTS.md ("the TypeScript bridge owns authentication, runtime tool
 * bridging, ...") it is the right place. It does NOT touch any other fetch.
 */

export interface DispatcherDefaults {
  /**
   * 0 disables the body timeout. Required: Anthropic's stream stays open for
   * the full agent run with multi-minute silent windows during tool execution.
   */
  bodyTimeout: number;
  /**
   * 30s — bounds cold-connect / TCP handshake hangs. Not 0, because the SDK's
   * 30-min response timeout only applies after headers are received; without
   * a finite headersTimeout a stuck handshake would never be aborted.
   */
  headersTimeout: number;
  /**
   * 60s — keep idle sockets warm for short follow-up calls (skill upload,
   * subsequent session events) without indefinite resource pinning.
   */
  keepAliveTimeout: number;
}

export const managedAgentDispatcherDefaults: DispatcherDefaults = {
  bodyTimeout: 0,
  headersTimeout: 30_000,
  keepAliveTimeout: 60_000,
};

interface UndiciModule {
  fetch: typeof fetch;
  Agent: typeof UndiciAgent;
  FormData?: typeof FormData;
  File?: typeof File;
  Blob?: typeof Blob;
  Response?: typeof Response;
  Request?: typeof Request;
  Headers?: typeof Headers;
}

interface CachedDispatcher {
  fetch: typeof fetch;
  agent: UndiciAgent;
}

let cached: CachedDispatcher | undefined;
let loadAttempted = false;
let loadError: unknown;
let cachedUndiciVersion: string | undefined;
let globalsAligned = false;

/**
 * Replace globalThis.{FormData,File,Blob,Response,Headers,Request} with the
 * variants from `undici`. Required so the Anthropic SDK's `new FormData()`
 * and our fetch's `Response.constructor` come from the same module instance —
 * otherwise its internal `supportsFormData` check fails and skill upload errors
 * with "The provided fetch function does not support file uploads...".
 *
 * Idempotent. Safe to call before our fetch is actually issued.
 */
function alignWebFetchGlobalsWith(undici: UndiciModule): void {
  if (globalsAligned) return;
  const target = globalThis as unknown as Record<string, unknown>;
  if (undici.FormData) target.FormData = undici.FormData;
  if (undici.File) target.File = undici.File;
  if (undici.Blob) target.Blob = undici.Blob;
  if (undici.Response) target.Response = undici.Response;
  if (undici.Request) target.Request = undici.Request;
  if (undici.Headers) target.Headers = undici.Headers;
  globalsAligned = true;
}

function tryLoadUndici(): CachedDispatcher | undefined {
  if (cached) return cached;
  if (loadAttempted) return undefined;
  loadAttempted = true;
  try {
    // require, not import — bundlers that statically analyze ESM imports cannot
    // replace this with a stub or tree-shake it. If npm undici is missing at
    // runtime the catch handles it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undici = require("undici") as UndiciModule;
    const agent = new undici.Agent(managedAgentDispatcherDefaults);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cachedUndiciVersion = (require("undici/package.json") as { version?: string }).version;
    } catch {
      // not fatal — version is informational only
    }
    alignWebFetchGlobalsWith(undici);
    cached = { fetch: undici.fetch, agent };
    return cached;
  } catch (error) {
    loadError = error;
    return undefined;
  }
}

export function getManagedAgentFetchLoadError(): unknown {
  return loadError;
}

export function getManagedAgentFetchPath(): "npm-undici" | "global-fallback" | "uninitialized" {
  if (cached) return "npm-undici";
  if (loadAttempted) return "global-fallback";
  return "uninitialized";
}

export function getManagedAgentUndiciVersion(): string | undefined {
  return cachedUndiciVersion;
}

/**
 * Eagerly trigger the dispatcher load so observability helpers
 * (`getManagedAgentFetchPath`) return a final state. Idempotent. Safe to call
 * before any fetch is actually issued.
 */
export function primeManagedAgentDispatcher(): void {
  tryLoadUndici();
}

export interface BuildLongLivedFetchOptions {
  /**
   * Override the dispatcher loader. Tests use this to simulate undici being
   * missing or `Agent` throwing.
   */
  loadDispatcher?: () => CachedDispatcher | undefined;
  /**
   * Fallback fetch. Defaults to `globalThis.fetch`. Tests inject a stub.
   */
  fallbackFetch?: typeof fetch;
  /**
   * One-time loud-failure sink. Defaults to a structured console.error.
   * Tests inject a stub.
   */
  onLoadFailure?: (error: unknown) => void;
}

/**
 * Returns a fetch that routes managed-agent calls through npm undici with a
 * long-lived Agent. Falls back to `globalThis.fetch` if npm undici is not
 * loadable, with a one-time loud error so the operator notices.
 */
export function buildLongLivedFetch(options: BuildLongLivedFetchOptions = {}): typeof fetch {
  const fallbackFetch = options.fallbackFetch ?? globalThis.fetch;
  if (typeof fallbackFetch !== "function") {
    throw new Error("buildLongLivedFetch: no fetch implementation available");
  }
  const loadDispatcher = options.loadDispatcher ?? tryLoadUndici;
  const onFailure = options.onLoadFailure ?? defaultLoadFailureHandler;
  let warned = false;

  const longLivedFetch: typeof fetch = (input, init) => {
    let dispatcher: CachedDispatcher | undefined;
    try {
      dispatcher = loadDispatcher();
    } catch (error) {
      // A throwing loader must never break the request.
      loadError = error;
    }

    if (dispatcher) {
      // Caller-provided dispatcher wins (e.g. test stubs that pass their own).
      const next = { ...(init ?? {}) } as RequestInit & { dispatcher?: unknown };
      if (!next.dispatcher) next.dispatcher = dispatcher.agent;
      return dispatcher.fetch(input as RequestInfo, next as RequestInit);
    }

    if (!warned) {
      warned = true;
      onFailure(getManagedAgentFetchLoadError());
    }
    return fallbackFetch(input as RequestInfo, init);
  };
  return longLivedFetch;
}

function defaultLoadFailureHandler(error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // Loud — operator should notice that we silently degraded to a 5-min body
  // timeout. Use error, not warn, so it shows up red and is harder to miss in
  // structured log aggregators.
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: "error",
      event: "managed_agent_fetch_fallback",
      message:
        "npm undici unavailable; falling back to globalThis.fetch (5-min body timeout). Long agent runs may terminate.",
      cause: detail || "unknown",
    }),
  );
}

/**
 * Test-only: drop the cached dispatcher and load state. Production code MUST
 * NOT call this; the cached agent is shared across all SDK calls.
 */
export function __resetManagedAgentFetchAgentForTests(): void {
  cached = undefined;
  loadAttempted = false;
  loadError = undefined;
  cachedUndiciVersion = undefined;
  globalsAligned = false;
}
