import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateViewerPosition, synchronizationAction } from "../public/sync.js";

test("viewer target advances from the TV sample and accounts for HLS start offset", () => {
  const position = estimateViewerPosition({
    positionSeconds: 100,
    paused: false,
    buffering: false,
    playbackRate: 1,
    receivedAtMs: 1_000,
  }, { offsetSeconds: 24 }, 3_500);

  assert.equal(position, 78.5);
});

test("paused and buffering TV states do not advance while wall time passes", () => {
  const paused = estimateViewerPosition({
    positionSeconds: 100,
    paused: true,
    buffering: false,
    playbackRate: 1,
    receivedAtMs: 1_000,
  }, { offsetSeconds: 24 }, 6_000);
  const buffering = estimateViewerPosition({
    positionSeconds: 100,
    paused: false,
    buffering: true,
    playbackRate: 1,
    receivedAtMs: 1_000,
  }, { offsetSeconds: 24 }, 6_000);

  assert.equal(paused, 76);
  assert.equal(buffering, 76);
});

test("sync ignores tiny drift, nudges moderate drift, and seeks large drift", () => {
  assert.deepEqual(synchronizationAction(10, 10.2), { type: "none", playbackRate: 1 });
  assert.deepEqual(synchronizationAction(10, 10.6), { type: "rate", playbackRate: 1.03 });
  assert.deepEqual(synchronizationAction(10, 9.4), { type: "rate", playbackRate: 0.97 });
  assert.deepEqual(synchronizationAction(10, 11.2), { type: "seek", positionSeconds: 11.2 });
});
