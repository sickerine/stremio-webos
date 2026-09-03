const SEEK_THRESHOLD_SECONDS = 2.5;
const DRIFT_CHECK_INTERVAL_MS = 30_000;

function projectedPosition(state, nowMs) {
  if (!state || state.paused) return state?.positionSeconds ?? 0;
  const elapsedSeconds = Math.max(0, nowMs - state.receivedAtMs) / 1000;
  return state.positionSeconds + (elapsedSeconds * state.playbackRate);
}

export function synchronizationActions(previous, next, anchor) {
  if (!previous || previous.sessionId !== next.sessionId) return ["queue"];

  const actions = [];
  if (previous.paused !== next.paused) actions.push(next.paused ? "pause" : "unpause");

  const expectedFromPrevious = projectedPosition(previous, next.receivedAtMs);
  const explicitSeek = Math.abs(next.positionSeconds - expectedFromPrevious) >= SEEK_THRESHOLD_SECONDS;
  const driftCheckDue = next.receivedAtMs - anchor.receivedAtMs >= DRIFT_CHECK_INTERVAL_MS;
  const expectedFromAnchor = projectedPosition(anchor, next.receivedAtMs);
  const accumulatedDrift = Math.abs(next.positionSeconds - expectedFromAnchor) >= SEEK_THRESHOLD_SECONDS;

  if (explicitSeek || (driftCheckDue && accumulatedDrift)) actions.push("seek");
  return actions;
}

export function shouldMoveAnchor(actions, anchor, sampleTimeMs) {
  return actions.includes("queue")
    || actions.includes("seek")
    || actions.includes("pause")
    || actions.includes("unpause")
    || sampleTimeMs - anchor.receivedAtMs >= DRIFT_CHECK_INTERVAL_MS;
}
