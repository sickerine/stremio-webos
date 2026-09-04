// Follow the TV by position only. Pure functions so they are unit-tested in Node.
//
// The TV heartbeats twice a second with its stabilized clock position. We estimate
// where it is now from the last sample and act on the difference. The TV never says
// it is buffering, but a "playing" TV whose position stops advancing is one (it sits
// at 0 for many seconds while loading a 4K stream); the browser then holds the frame
// too, instead of playing ahead and being yanked back.
export const STALL_MIN_GAP_MS = 400;  // two samples at least this far apart with the same position = stalled
export function tvStalled(prev, state, nowMs = Date.now()) {
  if (!prev || prev.sessionId !== state.sessionId || state.paused || prev.paused) return false;
  return Math.abs(state.positionSeconds - prev.positionSeconds) < 0.05 && nowMs - prev.receivedAtMs >= STALL_MIN_GAP_MS;
}
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

export const SNAP_BAND = 0.08;      // landing on a frame while the TV is paused: be this exact
export const SNAP_BAND_PLAYING = 0.25;  // right after a TV seek while playing: TV samples jitter as its clock re-locks, don't chase them
export const JUMP_BAND = 0.75;      // a sample this far off the prediction means the TV seeked
export const SNAP_WINDOW_MS = 2500; // after a jump, keep landing exactly while the TV's samples settle

// paused: the TV sits on a frame; land on that frame instead of merely pausing too.
// snap: the TV just seeked or toggled pause; land exactly rather than nudging the rate.
export function syncAction(currentSeconds, targetSeconds, { paused = false, snap = false } = {}) {
  const diff = targetSeconds - currentSeconds;
  const abs = Math.abs(diff);
  if (paused || snap) return abs <= (paused ? SNAP_BAND : SNAP_BAND_PLAYING) ? { type: "none", playbackRate: 1 } : { type: "seek", positionSeconds: targetSeconds };
  if (abs <= DEAD_BAND) return { type: "none", playbackRate: 1 };
  if (abs < NUDGE_BAND) return { type: "rate", playbackRate: diff > 0 ? 1 + NUDGE_RATE : 1 - NUDGE_RATE };
  return { type: "seek", positionSeconds: targetSeconds };
}

// Clock sync: each ping yields { rtt, offset } where offset = localMs - relayMs.
// Trust the one that travelled fastest; queueing only ever inflates the others.
export function bestOffset(samples) {
  let best = null;
  for (const s of samples) if (!best || s.rtt < best.rtt) best = s;
  return best ? best.offset : null;
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
