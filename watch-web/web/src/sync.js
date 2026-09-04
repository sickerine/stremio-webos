// Follow the TV by position only. Pure functions so they are unit-tested in Node.
//
// The TV heartbeats once a second with its stabilized clock position. We estimate
// where it is now from the last sample and act on the difference. We never mirror
// the TV's *buffering* as a browser pause: the browser has its own buffer and a
// stalled TV simply stops advancing the estimate.
export function estimateTvPosition(state, nowMs = Date.now()) {
  if (!state) return null;
  const sampledAt = state.receivedAtMs ?? state.sentAtMs ?? nowMs;
  const advance = !state.paused && !state.buffering;
  const elapsed = advance ? Math.max(0, nowMs - sampledAt) / 1000 : 0;
  return Math.max(0, state.positionSeconds + elapsed * (state.playbackRate || 1));
}

export const DEAD_BAND = 0.35;   // ignore differences below this
export const NUDGE_BAND = 3.0;   // gentle playbackRate correction up to this
export const NUDGE_RATE = 0.06;  // +-6% rate

export const SNAP_BAND = 0.08;      // landing on a frame (paused, or right after a TV seek): be this exact
export const JUMP_BAND = 0.75;      // a sample this far off the prediction means the TV seeked
export const SNAP_WINDOW_MS = 2500; // after a jump, keep landing exactly while the TV's samples settle

// paused: the TV sits on a frame; land on that frame instead of merely pausing too.
// snap: the TV just seeked or toggled pause; land exactly rather than nudging the rate.
export function syncAction(currentSeconds, targetSeconds, { paused = false, snap = false } = {}) {
  const diff = targetSeconds - currentSeconds;
  const abs = Math.abs(diff);
  if (paused || snap) return abs <= SNAP_BAND ? { type: "none", playbackRate: 1 } : { type: "seek", positionSeconds: targetSeconds };
  if (abs <= DEAD_BAND) return { type: "none", playbackRate: 1 };
  if (abs < NUDGE_BAND) return { type: "rate", playbackRate: diff > 0 ? 1 + NUDGE_RATE : 1 - NUDGE_RATE };
  return { type: "seek", positionSeconds: targetSeconds };
}

// Did this sample break from where the previous one predicted the TV would be?
export function tvJumped(prev, state, nowMs = Date.now()) {
  if (!prev || prev.sessionId !== state.sessionId) return false;
  return prev.paused !== state.paused || Math.abs(state.positionSeconds - estimateTvPosition(prev, nowMs)) > JUMP_BAND;
}

// Is `t` inside any buffered range (with a little slack)?
export function isBuffered(ranges, t, slack = 0.25) {
  for (const [s, e] of ranges) if (t >= s - slack && t <= e - slack) return true;
  return false;
}
