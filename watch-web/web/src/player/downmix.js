// Fold decoded surround audio to stereo. mediabunny only has real matrices for quad and
// 5.1; anything else (notably 7.1) falls back to keeping channels 0/1, which silently
// drops the centre channel and with it the dialogue. Channel order is the SMPTE/FFmpeg
// order both Chrome and Firefox decode to: FL FR FC LFE [BC] BL BR SL SR.
const c = Math.SQRT1_2;
const L = [1, 0], R = [0, 1], C = [c, c], NONE = [0, 0], SL = [c, 0], SR = [0, c];
const LAYOUTS = {
  3: [L, R, C],                              // 3.0
  5: [L, R, C, SL, SR],                      // 5.0
  6: [L, R, C, NONE, SL, SR],                // 5.1
  7: [L, R, C, NONE, C, SL, SR],             // 6.1 (back centre)
  8: [L, R, C, NONE, SL, SR, SL, SR],        // 7.1
};
export function stereoGains(channels) {
  const layout = LAYOUTS[channels] || Array.from({ length: channels }, (_, i) => (i === 0 ? L : i === 1 ? R : i === 2 ? C : i === 3 ? NONE : i % 2 ? SR : SL));
  const norm = 1 / layout.reduce((s, [l]) => s + l, 0);          // symmetric, so left's sum suffices
  return layout.map(([l, r]) => [l * norm, r * norm]);
}
/** interleaved f32 (frames*channels) -> interleaved stereo f32 (frames*2) */
export function downmixToStereo(src, channels, frames) {
  const g = stereoGains(channels), out = new Float32Array(frames * 2);
  for (let f = 0, i = 0, o = 0; f < frames; f++, i += channels, o += 2) {
    let l = 0, r = 0;
    for (let ch = 0; ch < channels; ch++) { const v = src[i + ch]; l += v * g[ch][0]; r += v * g[ch][1]; }
    out[o] = l; out[o + 1] = r;
  }
  return out;
}
