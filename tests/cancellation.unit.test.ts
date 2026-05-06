import assert from "node:assert/strict";
import { test } from "node:test";
import { CancellationError, CancellationState } from "../src/cancellation";

test("CancellationState starts not requested with a non-aborted signal", () => {
  const state = new CancellationState();
  assert.equal(state.requested, false);
  assert.equal(state.reason, undefined);
  assert.equal(state.signal.aborted, false);
});

test("CancellationState records the first reason and aborts the signal", () => {
  const state = new CancellationState();
  state.request("user-cancel");
  assert.equal(state.requested, true);
  assert.equal(state.reason, "user-cancel");
  assert.equal(state.signal.aborted, true);
});

test("CancellationState ignores subsequent requests after the first", () => {
  const state = new CancellationState();
  state.request("first");
  state.request("second");
  assert.equal(state.reason, "first");
});

test("CancellationState.throwIfRequested raises CancellationError when requested", () => {
  const state = new CancellationState();
  state.throwIfRequested();
  state.request("shutdown");
  assert.throws(() => state.throwIfRequested(), (error: unknown) => {
    return error instanceof CancellationError && /shutdown/.test(error.message);
  });
});

test("CancellationState propagates an already-aborted parent signal", () => {
  const parent = new AbortController();
  parent.abort(new Error("parent-shutdown"));
  const state = new CancellationState(parent.signal);
  assert.equal(state.requested, true);
  assert.equal(state.reason, "parent-shutdown");
});

test("CancellationState propagates a parent abort that fires after construction", async () => {
  const parent = new AbortController();
  const state = new CancellationState(parent.signal);
  assert.equal(state.requested, false);
  parent.abort(new Error("worker-shutdown"));
  // Microtask boundary so the listener fires.
  await Promise.resolve();
  assert.equal(state.requested, true);
  assert.equal(state.reason, "worker-shutdown");
});

test("CancellationState handles a parent abort with a non-Error reason", () => {
  const parent = new AbortController();
  parent.abort("string-reason");
  const state = new CancellationState(parent.signal);
  assert.equal(state.reason, "string-reason");
});
