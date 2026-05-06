/**
 * Cooperative cancellation state machine for the worker loop and runner.
 *
 * The worker owns one `CancellationState` per claimed job and forwards its
 * `signal` into the runner. The runner short-circuits whenever
 * `signal.aborted` becomes true (between phases or before issuing a
 * blocking call). A cancellation cause-of-death string is preserved so
 * the worker can emit a meaningful failure event.
 *
 * This module is deliberately small and pure so it can be exercised with
 * unit tests; the worker loop and live runner only consume the public
 * `request`, `signal`, `requested`, and `reason` accessors.
 */

export type CancellationReason = string;

export type CancellationView = {
  readonly requested: boolean;
  readonly reason?: CancellationReason;
  readonly signal: AbortSignal;
};

export class CancellationState implements CancellationView {
  readonly #controller: AbortController;
  #reason?: CancellationReason;

  constructor(parent?: AbortSignal) {
    this.#controller = new AbortController();
    if (parent?.aborted) {
      this.#reason = parentReason(parent) ?? "parent-aborted";
      this.#controller.abort();
    } else if (parent) {
      const onAbort = () => {
        if (this.#controller.signal.aborted) return;
        this.#reason = parentReason(parent) ?? "parent-aborted";
        this.#controller.abort();
        parent.removeEventListener("abort", onAbort);
      };
      parent.addEventListener("abort", onAbort, { once: true });
    }
  }

  /**
   * Mark cancellation as requested. Subsequent requests are no-ops; the
   * first request's reason is preserved.
   */
  request(reason: CancellationReason): void {
    if (this.#controller.signal.aborted) return;
    this.#reason = reason;
    this.#controller.abort();
  }

  get requested(): boolean {
    return this.#controller.signal.aborted;
  }

  get reason(): CancellationReason | undefined {
    return this.#reason;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /**
   * Throw a `CancellationError` if cancellation has been requested.
   * Useful between phases of long-running work.
   */
  throwIfRequested(): void {
    if (this.requested) {
      throw new CancellationError(this.#reason ?? "cancelled");
    }
  }
}

export class CancellationError extends Error {
  constructor(reason: CancellationReason) {
    super(`Cancelled: ${reason}`);
    this.name = "CancellationError";
  }
}

function parentReason(signal: AbortSignal): CancellationReason | undefined {
  if (!signal.aborted) return undefined;
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  if (reason === undefined || reason === null) return undefined;
  try {
    return String(reason);
  } catch {
    return undefined;
  }
}
