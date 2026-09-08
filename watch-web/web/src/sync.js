// Positions are anchored to TV capture time, translated into the local clock.
export function estimateTvPosition(state, nowMs = Date.now()) {
  if (!state) return null;
  const sampledAt = state.sampledAtMs;
  const advance = !state.paused && !state.buffering;
  const elapsed = advance ? Math.max(0, nowMs - sampledAt) / 1000 : 0;
  return Math.max(0, state.positionSeconds + elapsed * (state.playbackRate || 1));
}

export const DEAD_BAND = 0.35;   // ignore differences below this
export const NUDGE_BAND = 3.0;   // gentle playbackRate correction up to this
export const NUDGE_RATE = 0.06;  // +-6% rate

export const SNAP_BAND = 0.08;      // landing on a frame while the TV is paused: be this exact
export const SNAP_BAND_PLAYING = 0.25;  // right after a TV seek while playing: TV samples jitter as its clock re-locks, don't chase them

// paused: the TV sits on a frame; land on that frame instead of merely pausing too.
// snap: the TV just seeked or toggled pause; land exactly rather than nudging the rate.
export function syncAction(currentSeconds, targetSeconds, { paused = false, snap = false, playbackRate = 1, rateCorrection = true } = {}) {
  const diff = targetSeconds - currentSeconds;
  const abs = Math.abs(diff);
  if (paused || snap) return abs <= (paused ? SNAP_BAND : SNAP_BAND_PLAYING) ? { type: "none", playbackRate } : { type: "seek", positionSeconds: targetSeconds };
  if (abs <= DEAD_BAND) return { type: "none", playbackRate };
  // Safari can pause audio/video when playbackRate changes. Keep native managed
  // playback steady between explicit TV events; still recover large drift.
  if (abs < NUDGE_BAND && !rateCorrection) return { type: "none", playbackRate };
  if (abs < NUDGE_BAND) return { type: "rate", playbackRate: playbackRate * (diff > 0 ? 1 + NUDGE_RATE : 1 - NUDGE_RATE) };
  return { type: "seek", positionSeconds: targetSeconds };
}

// Is `t` inside any buffered range (with a little slack)?
export function isBuffered(ranges, t, slack = 0.25) {
  for (const [s, e] of ranges) if (t >= s - slack && t <= e - slack) return true;
  return false;
}
