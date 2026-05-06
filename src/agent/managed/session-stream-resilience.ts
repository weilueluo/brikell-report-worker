/**
 * Stream-disconnect resilience for managed-agent session events.
 *
 * Why this exists:
 * Even with the long-lived undici fetch (see streaming-fetch.ts), transient
 * network failures (NAT timeout, TLS reset, ISP blip) can drop the SSE event
 * stream mid-session. Without resume, a single network blip fails the whole
 * job. With resume, the agent continues uninterrupted.
 *
 * Why polling, not stream-resume:
 * The Anthropic SDK's `events.stream(sessionId)` does NOT accept a resume
 * cursor (only `betas?` per `EventStreamParams`). Reopening a stream and
 * draining `events.list()` to fill the gap has a race: events emitted between
 * the last list page and the new stream becoming live can be lost.
 *
 * The honest, gap-free strategy: on disconnect, abandon streaming for the rest
 * of the session and switch to polling `events.list({ order: 'asc' })`,
 * deduplicating via a Set of seen event IDs. `events.list` is paginated and
 * stable; polling guarantees we see every event the server has written, in
 * order. The trade-off is real-time UX after a disconnect — usually the
 * disconnect happens during a long, silent tool call where there is nothing to
 * display anyway.
 *
 * Three triggers fall through to polling:
 * - Phase 1 throws (network error, broken socket).
 * - Phase 1 stays silent past `streamIdleTimeoutMs` (the watchdog throws).
 * - Phase 1 returns `done: true` cleanly BUT the last event was not a real
 *   terminal — Anthropic appears to close the SSE stream after every
 *   `session.status_idle` regardless of stop_reason. When stop_reason is
 *   `requires_action`, the agent is paused waiting for tool results and will
 *   produce more events after the bridge calls `events.send`. Without this
 *   fallback those events are lost and the run silently completes with no
 *   artifact submitted (see incident with session
 *   sesn_011CagMUTRVUEuYb6RAe3dVb on 2026-05-03 — agent emitted events 21-29
 *   on a fresh stream we never opened).
 *
 * Caps:
 * - `maxPollingMs` bounds the post-disconnect tail (default 30 min) — prevents
 *   a session from polling forever after the agent quietly stalls.
 * - Backoff caps individual poll intervals at 10 s.
 */
import { isRealTerminalSessionEvent } from "./terminal-events";

export interface SessionEventStreamLike {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

export interface SessionEventsListClient {
  list(
    sessionId: string,
    params?: { order?: "asc" | "desc"; limit?: number; page?: string | null } | null,
  ): AsyncIterable<unknown>;
}

export interface SessionEventsClient extends SessionEventsListClient {
  stream(sessionId: string): Promise<SessionEventStreamLike>;
}

export interface BetaSessionsLike {
  sessions: { events: SessionEventsClient };
}

export interface IterateOptions {
  /**
   * Called once per disconnect→reconnect transition. For observability only.
   * If it throws the iterator still proceeds.
   */
  onReconnect?: (info: { reason: string; seenCount: number; lastEventId?: string }) => void;
  /**
   * Total wall-clock cap on the polling tail. Default 30 min.
   */
  maxPollingMs?: number;
  /**
   * Initial polling interval. Backoff multiplies up from here when polls return
   * no new events. Default 1500 ms.
   */
  pollIntervalMs?: number;
  /**
   * Maximum backoff between polls. Default 10 s.
   */
  maxPollIntervalMs?: number;
  /**
   * Phase-1 idle watchdog: if the SSE stream emits no event within this many
   * milliseconds, the iterator force-throws and falls through to polling. Real
   * incident pinned this need: the agent went session.status_idle (requires
   * action) waiting for tool results we'd already sent, and the SSE socket
   * stayed open with no events, no error. Without this watchdog the iterator
   * sat in `for await` forever until Vercel's 60-min function cap killed it.
   * Default 90 s.
   */
  streamIdleTimeoutMs?: number;
  /**
   * Sleep helper. Tests inject a fake clock.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Wall-clock source. Tests inject a fake clock.
   */
  now?: () => number;
}

export interface ReconnectInfo {
  reason: string;
  seenCount: number;
  lastEventId?: string;
}

const DEFAULT_OPTIONS: Required<
  Pick<IterateOptions, "maxPollingMs" | "pollIntervalMs" | "maxPollIntervalMs" | "streamIdleTimeoutMs">
> = {
  maxPollingMs: 30 * 60 * 1000,
  pollIntervalMs: 1_500,
  maxPollIntervalMs: 10_000,
  streamIdleTimeoutMs: 90_000,
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Yield events from `initialStream` first; on stream error OR a long silent
 * window (streamIdleTimeoutMs) switch to polling
 * `beta.sessions.events.list(sessionId)` until a terminal session event
 * arrives or the polling cap is hit.
 *
 * Dedupe is by event `id`. Events without `id` are passed through unchanged.
 */
export async function* iterateSessionEventsResilient(
  beta: BetaSessionsLike,
  sessionId: string,
  initialStream: SessionEventStreamLike,
  options: IterateOptions = {},
): AsyncGenerator<unknown, void, void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const seenIds = new Set<string>();
  let lastEventId: string | undefined;

  // Phase 1: streaming with idle watchdog.
  // We pull next() manually instead of using `for await` so we can race the
  // pull against a watchdog timer. If the stream stays silent past
  // streamIdleTimeoutMs we synthesise a thrown error so the catch falls
  // through to the polling fallback.
  const iterator = (initialStream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  // Track the most recent event we OBSERVED on the stream, regardless of
  // whether we yielded it (a duplicate ID gets skipped via dedupe but is still
  // a real event the server delivered). On clean EOF we read this to decide
  // whether the stream genuinely ended (real terminal) or closed prematurely
  // mid-turn — the latter must fall through to Phase 2 polling.
  let lastObservedEvent: unknown;
  let phase1ClosedEarly = false;
  try {
    while (true) {
      const idleTimeoutMs = opts.streamIdleTimeoutMs;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let idleResolve: ((value: { stalled: true }) => void) | undefined;
      const idlePromise = new Promise<{ stalled: true }>((resolve) => {
        idleResolve = resolve;
        timeoutHandle = setTimeout(() => resolve({ stalled: true }), idleTimeoutMs);
        // unref so the watchdog timer doesn't keep the process / test-runner
        // event loop alive when the iterator exits via throw or done.
        if (typeof timeoutHandle?.unref === "function") timeoutHandle.unref();
      });
      const next = iterator.next();
      let winner: { stalled: true } | { stalled: false; result: IteratorResult<unknown> };
      try {
        winner = await Promise.race([
          next.then((r) => ({ stalled: false as const, result: r })),
          idlePromise,
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        // Idempotent — settles the idle promise even when next() won the race.
        // Without this the Promise stays pending forever and Node's test
        // runner flags "Promise resolution is still pending".
        if (idleResolve) idleResolve({ stalled: true });
      }
      if (winner.stalled) {
        // Best-effort cancel of the abandoned next(). We DO NOT await — the
        // pending fetch may sit forever in real SSE clients (the whole reason
        // this watchdog exists), and awaiting it here would re-introduce the
        // hang we're protecting against.
        if (typeof iterator.return === "function") {
          void iterator.return(undefined).catch(() => {
            // Ignore — we're already abandoning the stream.
          });
        }
        throw new Error(
          `iterateSessionEventsResilient: SSE stream emitted no event for ${idleTimeoutMs}ms (session ${sessionId}); switching to polling.`,
        );
      }
      if (winner.result.done) {
        // Stream closed cleanly. Decide whether that means the session is
        // truly done (real terminal event) or whether Anthropic just closed
        // the SSE socket while the agent is still working.
        if (lastObservedEvent && isRealTerminalSessionEvent(lastObservedEvent)) {
          return;
        }
        phase1ClosedEarly = true;
        break;
      }
      const event = winner.result.value;
      lastObservedEvent = event;
      const id = (event as { id?: string })?.id;
      if (id) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        lastEventId = id;
      }
      yield event;
    }
  } catch (streamError) {
    options.onReconnect?.({
      reason: errorMessage(streamError),
      seenCount: seenIds.size,
      lastEventId,
    });
  }

  if (phase1ClosedEarly) {
    options.onReconnect?.({
      reason: "stream-closed-without-terminal",
      seenCount: seenIds.size,
      lastEventId,
    });
  }

  // Phase 2: polling fallback. Walk the full list, dedupe via seenIds.
  const startedAt = now();
  let pollIntervalMs = opts.pollIntervalMs;
  let sawTerminal = false;

  while (!sawTerminal) {
    if (now() - startedAt > opts.maxPollingMs) {
      throw new Error(
        `iterateSessionEventsResilient: polling cap of ${opts.maxPollingMs}ms exceeded for session ${sessionId}`,
      );
    }

    let listError: unknown;
    const pageEvents: unknown[] = [];
    try {
      const list = beta.sessions.events.list(sessionId, { order: "asc" });
      for await (const event of list as AsyncIterable<unknown>) {
        pageEvents.push(event);
      }
    } catch (error) {
      listError = error;
    }

    if (listError) {
      // Polling itself failed. Back off and try again until the wall-clock cap.
      pollIntervalMs = Math.min(pollIntervalMs * 2, opts.maxPollIntervalMs);
      await sleep(pollIntervalMs);
      continue;
    }

    let newEventCount = 0;
    for (const event of pageEvents) {
      const id = (event as { id?: string })?.id;
      if (id) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        lastEventId = id;
      }
      newEventCount++;
      yield event;
      // status_idle with stop_reason=requires_action means the agent is paused
      // waiting for tool results — NOT a real terminal. The bridge will send
      // results via beta.sessions.events.send and the agent will produce more
      // events. Polling must keep going past these intermediate idles.
      if (isRealTerminalSessionEvent(event)) {
        sawTerminal = true;
        break;
      }
    }

    if (sawTerminal) return;

    if (newEventCount === 0) {
      // No new events — increase backoff.
      pollIntervalMs = Math.min(Math.floor(pollIntervalMs * 1.5), opts.maxPollIntervalMs);
    } else {
      // Progress made — reset to base interval.
      pollIntervalMs = opts.pollIntervalMs;
    }
    await sleep(pollIntervalMs);
  }
}
