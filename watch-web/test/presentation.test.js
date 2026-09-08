import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentedFrame, seekLead } from '../web/src/player/presentation.js';
import { estimateTvPosition } from '../web/src/sync.js';

function video() {
  let callback;
  return Object.assign(new EventTarget(), { seeking: false, cancelled: 0,
    requestVideoFrameCallback(fn) { callback = fn; return 1; },
    cancelVideoFrameCallback() { this.cancelled++; callback = null; },
    frame(mediaTime) { callback?.(performance.now(), { mediaTime, expectedDisplayTime: -100000 }); },
  });
}

test('seek completion requires the target frame, not the setter or a stale frame', async () => {
  const v = video(); let finished = false;
  const result = presentedFrame(v, () => {}, { target: 20 }).then(x => { finished = true; return x; });
  await Promise.resolve(); assert.equal(finished, false);
  v.frame(10); await Promise.resolve(); assert.equal(finished, false);
  v.seeking = true; v.frame(20); await Promise.resolve(); assert.equal(finished, false);
  v.seeking = false; v.dispatchEvent(new Event('seeked'));
  const frame = await result;
  assert.equal(frame.mediaTime, 20);
  assert.ok(frame.latencyMs >= 0, 'invalid expectedDisplayTime cannot corrupt the duration');
  assert.equal(v.cancelled, 1);
});

test('stop cancels a presentation wait and removes its frame callback', async () => {
  const v = video(), abort = new AbortController();
  const result = presentedFrame(v, () => {}, { signal: abort.signal });
  abort.abort();
  assert.equal(await result, null);
  assert.equal(v.cancelled, 1);
});

test('seek latency uses recent bounded measurements and only advances moving targets', () => {
  assert.equal(seekLead([]), 0);
  assert.equal(seekLead([60, 80, 100, 9000, NaN]), 80);
  const state = { sampledAtMs: 1000, positionSeconds: 10, playbackRate: 2 };
  assert.equal(estimateTvPosition(state, 1500 + 80), 11.16);
  assert.equal(estimateTvPosition({ ...state, paused: true }, 1500 + 80), 10);
  assert.equal(estimateTvPosition({ ...state, buffering: true }, 1500 + 80), 10);
});
