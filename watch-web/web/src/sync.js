// Positions are anchored to TV capture time, translated into the local clock.
export function estimateTvPosition(state, nowMs = Date.now()) {
  if (!state) return null;
  const sampledAt = state.sampledAtMs;
  const advance = !state.paused && !state.buffering;
  const elapsed = advance ? Math.max(0, nowMs - sampledAt) / 1000 : 0;
  return Math.max(0, state.positionSeconds + elapsed * (state.playbackRate || 1));
}

export const DRIFT_BAND = 0.04;  // start correcting beyond this
export const SYNC_BAND = 0.015;  // once correcting, keep going until this close
export const JUMP_BAND = 0.5;    // beyond this, jump when the target is already buffered
export const NUDGE_BAND = 3.0;   // gentle playbackRate correction up to this
export const NUDGE_RATE = 0.06;  // +-6% rate

export const SNAP_BAND = 0.08;      // landing on a frame while the TV is paused: be this exact
export const SNAP_BAND_PLAYING = 0.08;  // align explicit playing actions to the presented frame

// paused: the TV sits on a frame; land on that frame instead of merely pausing too.
// snap: the TV just seeked or toggled pause; land exactly rather than nudging the rate.
// nudging: a rate correction is already running, so finish it instead of stopping at the outer band.
// buffered: the target is in the buffer, so a jump costs nothing.
export function syncAction(currentSeconds, targetSeconds, { paused = false, snap = false, playbackRate = 1, rateCorrection = true, nudging = false, buffered = false } = {}) {
  const diff = targetSeconds - currentSeconds;
  const abs = Math.abs(diff);
  if (paused || snap) return abs <= (paused ? SNAP_BAND : SNAP_BAND_PLAYING) ? { type: "none", playbackRate } : { type: "seek", positionSeconds: targetSeconds };
  // Safari can pause audio/video when playbackRate changes. Keep native managed
  // playback steady between explicit TV events; still recover large drift.
  if (abs < NUDGE_BAND && !rateCorrection) return { type: "none", playbackRate };
  if (abs <= (nudging ? SYNC_BAND : DRIFT_BAND)) return { type: "none", playbackRate };
  if (abs < NUDGE_BAND && !(buffered && abs > JUMP_BAND)) return { type: "rate", playbackRate: playbackRate * (diff > 0 ? 1 + NUDGE_RATE : 1 - NUDGE_RATE) };
  return { type: "seek", positionSeconds: targetSeconds };
}

export const FEED_WAIT_S = 20;   // a mux this close behind the target is worth waiting for

// Will the running mux reach `target` without a restart? Only while it feeds freely:
// once it is held to its lead ahead of the playhead, it follows the playhead and a
// target that moves at the same speed stays out of reach for good.
export function feedWillReach(run, target) {
  return Boolean(run && !run.cancelled && !run.throttled && run.fedTs != null &&
    target >= run.startAt && target >= run.fedTs && target - run.fedTs < FEED_WAIT_S);
}

// Is `t` inside any buffered range (with a little slack)?
export function isBuffered(ranges, t, slack = 0.25) {
  for (const [s, e] of ranges) if (t >= s - slack && t <= e - slack) return true;
  return false;
}
