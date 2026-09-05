import { test } from "node:test";
import assert from "node:assert/strict";
import { downmixToStereo, stereoGains } from "../web/src/player/downmix.js";

const frame = (channels, fill) => { const a = new Float32Array(channels); for (const [ch, v] of Object.entries(fill)) a[ch] = v; return a; };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("7.1 downmix keeps the centre (dialogue) channel in both ears and drops LFE", () => {
  const [l, r] = downmixToStereo(frame(8, { 2: 1 }), 8, 1);
  assert.ok(l > 0.2 && Math.abs(l - r) < 1e-6, `centre lost: ${l} ${r}`);
  assert.deepEqual([...downmixToStereo(frame(8, { 3: 1 }), 8, 1)], [0, 0]);
  const [fl, fr] = downmixToStereo(frame(8, { 0: 1 }), 8, 1);
  assert.ok(fl > 0 && fr === 0);
  const [sl, sr] = downmixToStereo(frame(8, { 6: 1 }), 8, 1);       // side left -> left only
  assert.ok(sl > 0 && sr === 0);
});

test("gains are normalised so a full-scale mix cannot clip", () => {
  for (const ch of [3, 5, 6, 7, 8, 10]) { const g = stereoGains(ch); near(g.reduce((s, [l]) => s + l, 0), 1); near(g.reduce((s, [, r]) => s + r, 0), 1); }
  const [l, r] = downmixToStereo(new Float32Array(8).fill(1), 8, 1);
  near(l, 1); near(r, 1);
});

test("interleaving: frames map one-to-one", () => {
  const src = new Float32Array([1, 0, 0, 0, 0, 0, /* frame 2 */ 0, 1, 0, 0, 0, 0]);
  const out = downmixToStereo(src, 6, 2);
  assert.equal(out.length, 4);
  assert.ok(out[0] > 0 && out[1] === 0 && out[2] === 0 && out[3] > 0);
});
