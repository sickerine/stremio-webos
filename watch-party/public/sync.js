export function estimateViewerPosition(state, media, nowMs = Date.now()) {
  if (!state) return 0;
  const offsetSeconds = media?.offsetSeconds || 0;
  const sampledAtMs = state.viewerReceivedAtMs || state.receivedAtMs || nowMs;
  const shouldAdvance = !state.paused && !state.buffering;
  const elapsedSeconds = shouldAdvance ? Math.max(0, nowMs - sampledAtMs) / 1000 : 0;
  return Math.max(0, state.positionSeconds + elapsedSeconds * state.playbackRate - offsetSeconds);
}

export function synchronizationAction(currentSeconds, targetSeconds) {
  const difference = targetSeconds - currentSeconds;
  const absoluteDifference = Math.abs(difference);

  if (absoluteDifference <= 0.25) return { type: "none", playbackRate: 1 };
  if (absoluteDifference < 1) {
    return { type: "rate", playbackRate: difference > 0 ? 1.03 : 0.97 };
  }
  return { type: "seek", positionSeconds: targetSeconds };
}
