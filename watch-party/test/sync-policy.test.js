import assert from "node:assert/strict";
import { test } from "node:test";

import { synchronizationActions } from "../src/sync-policy.js";

function state(overrides = {}) {
  return {
    sessionId: "episode-1",
    sequence: 1,
    positionSeconds: 10,
    paused: false,
    playbackRate: 1,
    receivedAtMs: 1_000,
    ...overrides,
  };
}

test("a new TV playback session queues the selected item once", () => {
  assert.deepEqual(synchronizationActions(null, state(), state(), 1_000), ["queue"]);
});

test("normal heartbeats do not repeatedly pause, play, or seek", () => {
  const previous = state();
  const next = state({ sequence: 2, positionSeconds: 11, receivedAtMs: 2_000 });
  assert.deepEqual(synchronizationActions(previous, next, previous, 2_000), []);
});

test("buffering noise has no effect on synchronization", () => {
  const previous = state();
  const next = state({ sequence: 2, positionSeconds: 11, receivedAtMs: 2_000, buffering: true });
  assert.deepEqual(synchronizationActions(previous, next, previous, 2_000), []);
});

test("pause and resume transitions emit exactly one command", () => {
  const playing = state();
  const paused = state({ sequence: 2, positionSeconds: 11, paused: true, receivedAtMs: 2_000 });
  const resumed = state({ sequence: 3, positionSeconds: 11, paused: false, receivedAtMs: 3_000 });
  assert.deepEqual(synchronizationActions(playing, paused, playing, 2_000), ["pause"]);
  assert.deepEqual(synchronizationActions(paused, resumed, paused, 3_000), ["unpause"]);
});

test("a deliberate TV seek is forwarded", () => {
  const previous = state();
  const next = state({ sequence: 2, positionSeconds: 90, receivedAtMs: 2_000 });
  assert.deepEqual(synchronizationActions(previous, next, previous, 2_000), ["seek"]);
});

test("small clock differences do not cause a seek storm", () => {
  const anchor = state();
  const previous = state({ sequence: 30, positionSeconds: 39.1, receivedAtMs: 30_000 });
  const next = state({ sequence: 31, positionSeconds: 40.2, receivedAtMs: 31_000 });
  assert.deepEqual(synchronizationActions(previous, next, anchor, 31_000), []);
});
