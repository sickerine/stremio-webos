import assert from "node:assert/strict";
import { test } from "node:test";

import { createCoordinator } from "../src/coordinator.js";

function tvState(overrides = {}) {
  return {
    sessionId: "real-stream",
    sequence: 1,
    positionSeconds: 10,
    paused: false,
    playbackRate: 1,
    mediaUrl: "https://example.test/episode.mkv",
    receivedAtMs: 1_000,
    ...overrides,
  };
}

test("coordinator imports and queues a source, then ignores ordinary heartbeats", async () => {
  const calls = [];
  const jellyfin = {
    ensureGroup: async name => calls.push(["group", name]),
    setQueue: async (id, position) => calls.push(["queue", id, position]),
    pause: async () => calls.push(["pause"]),
    unpause: async () => calls.push(["unpause"]),
    seek: async position => calls.push(["seek", position]),
  };
  const mediaLibrary = {
    importStream: async state => { calls.push(["import", state.mediaUrl]); return { Id: "jellyfin-item" }; },
  };
  const coordinator = createCoordinator({ jellyfin, mediaLibrary });

  assert.deepEqual(await coordinator.update(tvState()), ["queue"]);
  assert.deepEqual(await coordinator.update(tvState({ sequence: 2, positionSeconds: 11, receivedAtMs: 2_000 })), []);
  assert.deepEqual(calls, [
    ["import", "https://example.test/episode.mkv"],
    ["group", "home"],
    ["queue", "jellyfin-item", 10],
    ["unpause"],
  ]);
});

test("coordinator serializes updates and forwards only meaningful transitions", async () => {
  const calls = [];
  const jellyfin = {
    ensureGroup: async () => {}, setQueue: async () => {}, unpause: async () => {},
    pause: async () => calls.push("pause"), seek: async position => calls.push(`seek:${position}`),
  };
  const coordinator = createCoordinator({
    jellyfin,
    mediaLibrary: { importStream: async () => ({ Id: "item" }) },
  });
  await coordinator.update(tvState());
  await coordinator.update(tvState({ sequence: 2, paused: true, positionSeconds: 80, receivedAtMs: 2_000 }));
  assert.deepEqual(calls, ["seek:80", "pause"]);
});

test("slow initial indexing cannot turn queued heartbeats into false seeks", async () => {
  const calls = [];
  const jellyfin = {
    ensureGroup: async () => {}, setQueue: async () => {}, unpause: async () => {}, pause: async () => {},
    seek: async position => calls.push(position),
  };
  let finishImport;
  const coordinator = createCoordinator({
    jellyfin,
    mediaLibrary: { importStream: () => new Promise(resolve => { finishImport = () => resolve({ Id: "item" }); }) },
  });
  const first = coordinator.update(tvState());
  const heartbeat = coordinator.update(tvState({ sequence: 2, positionSeconds: 11, receivedAtMs: 2_000 }));
  await Promise.resolve();
  finishImport();
  await Promise.all([first, heartbeat]);
  assert.deepEqual(calls, []);
});

test("duplicate and stale state samples are ignored", async () => {
  const calls = [];
  const jellyfin = {
    ensureGroup: async () => {}, setQueue: async () => {}, unpause: async () => {}, pause: async () => {},
    seek: async position => calls.push(position),
  };
  const coordinator = createCoordinator({ jellyfin, mediaLibrary: { importStream: async () => ({ Id: "item" }) } });
  await coordinator.update(tvState({ sequence: 5 }));
  assert.deepEqual(await coordinator.update(tvState({ sequence: 4, positionSeconds: 90 })), []);
  assert.deepEqual(calls, []);
});
