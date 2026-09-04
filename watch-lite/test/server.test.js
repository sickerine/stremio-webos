import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createWatchLiteServer } from "../src/server.js";

function fakeMediaManager() {
  const calls = { prepare: [], release: [] };
  return {
    calls,
    prepare(state, publish) { calls.prepare.push(state.sessionId); publish({ status: "ready", sessionId: state.sessionId, playbackUrl: "/media/x/master.m3u8", offsetSeconds: 0 }); },
    release(id) { calls.release.push(id); },
    close() {},
  };
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on("message", raw => inbox.push(JSON.parse(raw)));
    ws.on("open", () => resolve({ ws, inbox }));
    ws.on("error", reject);
  });
}
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

test("TV state with no room param lands in 'home', viewer gets media, TV idle resets to waiting", async () => {
  const mediaManager = fakeMediaManager();
  const server = createWatchLiteServer({ mediaManager, mediaRoot: "/tmp/wl-test" });
  await server.listen(0, "127.0.0.1");
  const base = `ws://127.0.0.1:${server.address().port}/ws`;

  const viewer = await open(`${base}?role=viewer`);           // default room "home"
  const tv = await open(`${base}?role=tv`);                    // exactly what the TV bridge sends
  tv.ws.send(JSON.stringify({ type: "state", state: {
    sessionId: "s1", sequence: 1, positionSeconds: 10, paused: false, playbackRate: 1,
    mediaUrl: "https://example.com/ep.mkv", title: "ep",
  }}));
  await tick();
  assert.deepEqual(mediaManager.calls.prepare, ["s1"]);
  assert.ok(viewer.inbox.some(m => m.type === "media-state" && m.media.status === "ready"));

  tv.ws.send(JSON.stringify({ type: "idle", sessionId: "s1" }));
  await tick();
  assert.deepEqual(mediaManager.calls.release, ["s1"]);
  assert.ok(viewer.inbox.some(m => m.type === "room-idle"));

  // viewers cannot publish state
  viewer.ws.send(JSON.stringify({ type: "state", state: { sessionId: "hack", sequence: 1, positionSeconds: 0, mediaUrl: "https://x" } }));
  await tick();
  assert.ok(viewer.inbox.some(m => m.type === "error" && m.code === "viewer-read-only"));
  assert.deepEqual(mediaManager.calls.prepare, ["s1"]);

  viewer.ws.close(); tv.ws.close();
  await server.close();
});
