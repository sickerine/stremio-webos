import { shouldMoveAnchor, synchronizationActions } from "./sync-policy.js";

const VIEWER_DRIFT_CHECK_INTERVAL_MS = 15_000;

export function createCoordinator({ jellyfin, mediaLibrary }) {
  let previous = null;
  let anchor = null;
  let queue = Promise.resolve();
  let currentItem = null;
  let lastViewerDriftCheckAt = 0;

  async function apply(state) {
    if (previous && previous.sessionId === state.sessionId && previous.sequence >= state.sequence) return [];
    const actions = synchronizationActions(previous, state, anchor || state);

    if (actions.includes("queue")) {
      currentItem = await mediaLibrary.importStream(state);
    }

    const checkDrift = actions.includes("queue")
      || state.receivedAtMs - lastViewerDriftCheckAt >= VIEWER_DRIFT_CHECK_INTERVAL_MS;
    await jellyfin.syncViewers(currentItem.Id, state, { actions, checkDrift });
    if (checkDrift) lastViewerDriftCheckAt = state.receivedAtMs;

    if (!anchor || shouldMoveAnchor(actions, anchor, state.receivedAtMs)) anchor = state;
    previous = state;
    return actions;
  }

  return {
    update(state) {
      const operation = queue.then(() => apply(state));
      queue = operation.catch(() => {});
      return operation;
    },
    status() { return { itemId: currentItem?.Id || null, state: previous }; },
  };
}
