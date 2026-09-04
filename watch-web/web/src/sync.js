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

export function syncAction(currentSeconds, targetSeconds) {
  const diff = targetSeconds - currentSeconds;
  const abs = Math.abs(diff);
  if (abs <= DEAD_BAND) return { type: "none", playbackRate: 1 };
  if (abs < NUDGE_BAND) return { type: "rate", playbackRate: diff > 0 ? 1 + NUDGE_RATE : 1 - NUDGE_RATE };
  return { type: "seek", positionSeconds: targetSeconds };
}

// Is `t` inside any buffered range (with a little slack)?
export function isBuffered(ranges, t, slack = 0.25) {
  for (const [s, e] of ranges) if (t >= s - slack && t <= e - slack) return true;
  return false;
}
