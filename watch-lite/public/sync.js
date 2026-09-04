// Follow the TV by POSITION ONLY. We never mirror the TV's buffering as a browser
// pause: that was the pause storm in the old build. If the TV stalls, the browser
// keeps playing its own already-remuxed HLS and the position estimate simply stops
// advancing until the next real sample.
export function estimateViewerPosition(state, media, nowMs = Date.now()) {
  if (!state) return 0;
  const offsetSeconds = media?.offsetSeconds || 0;
  const sampledAtMs = state.viewerReceivedAtMs ?? state.receivedAtMs ?? nowMs;
  const advance = !state.paused && !state.buffering;
  const elapsed = advance ? Math.max(0, nowMs - sampledAtMs) / 1000 : 0;
  return Math.max(0, state.positionSeconds + elapsed * state.playbackRate - offsetSeconds);
}

export function synchronizationAction(currentSeconds, targetSeconds) {
  const diff = targetSeconds - currentSeconds;
  const abs = Math.abs(diff);
  if (abs <= 0.5) return { type: "none", playbackRate: 1 };
  if (abs < 3) return { type: "rate", playbackRate: diff > 0 ? 1.05 : 0.95 };
  return { type: "seek", positionSeconds: targetSeconds };
}
