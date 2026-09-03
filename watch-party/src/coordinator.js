import { shouldMoveAnchor, synchronizationActions } from "./sync-policy.js";

export function createCoordinator({ jellyfin, mediaLibrary, groupName = "home" }) {
  let previous = null;
  let anchor = null;
  let queue = Promise.resolve();
  let currentItem = null;

  async function apply(state) {
    if (previous && previous.sessionId === state.sessionId && previous.sequence >= state.sequence) return [];
    const actions = synchronizationActions(previous, state, anchor || state);

    if (actions.includes("queue")) {
      currentItem = await mediaLibrary.importStream(state);
      await jellyfin.ensureGroup(groupName);
      await jellyfin.setQueue(currentItem.Id, state.positionSeconds);
      await (state.paused ? jellyfin.pause() : jellyfin.unpause());
    } else {
      if (actions.includes("seek")) await jellyfin.seek(state.positionSeconds);
      if (actions.includes("pause")) await jellyfin.pause();
      if (actions.includes("unpause")) await jellyfin.unpause();
    }

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
