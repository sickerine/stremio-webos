import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import WebSocket from "ws";

import { createJellyfinProxy } from "../src/jellyfin-proxy.js";
import { createBridgeServer, normalizeState } from "../src/server.js";

const servers = [];
afterEach(async () => Promise.all(servers.splice(0).map(server => server.close())));

function nextMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 1_000);
    const listener = data => {
      const message = JSON.parse(data.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });
}

test("normalization rejects states without a playable HTTP source", () => {
  assert.equal(normalizeState({ sessionId: "x", sequence: 1, positionSeconds: 0 }), null);
  assert.equal(normalizeState({ sessionId: "x", sequence: 1, positionSeconds: 0, mediaUrl: "file:///x" }), null);
});

test("TV state reaches the coordinator and receives an action acknowledgement", async () => {
  const states = [];
  const coordinator = {
    update: async state => { states.push(state); return ["queue"]; },
    status: () => ({ itemId: null, state: null }),
  };
  const server = createBridgeServer({ coordinator, now: () => 5_000 });
  await server.listen(0, "127.0.0.1");
  servers.push(server);
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?role=tv&room=home`);
  const hello = nextMessage(socket, "hello");
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  await hello;
  const ack = nextMessage(socket, "ack");
  socket.send(JSON.stringify({
    type: "state",
    state: {
      sessionId: "episode", sequence: 7, positionSeconds: 42, paused: false,
      playbackRate: 1, buffering: true, mediaUrl: "https://torbox.example/episode.mkv",
    },
  }));
  assert.deepEqual(await ack, { type: "ack", sequence: 7, actions: ["queue"] });
  assert.equal(states[0].receivedAtMs, 5_000);
  assert.equal("buffering" in states[0], false);
  socket.close();
});

test("a viewer waits, follows the active TV session, and returns to waiting on TV idle", async () => {
  const coordinator = {
    update: async () => ["queue"],
    status: () => ({ itemId: "item-1", state: null }),
  };
  const server = createBridgeServer({ coordinator, now: () => 5_000 });
  await server.listen(0, "127.0.0.1");
  servers.push(server);
  const port = server.address().port;
  const viewer = new WebSocket(`ws://127.0.0.1:${port}/ws?role=viewer`);
  const initial = nextMessage(viewer, "viewer-state");
  await new Promise((resolve, reject) => { viewer.once("open", resolve); viewer.once("error", reject); });
  assert.deepEqual(await initial, { type: "viewer-state", mode: "waiting" });

  const tv = new WebSocket(`ws://127.0.0.1:${port}/ws?role=tv`);
  await new Promise((resolve, reject) => { tv.once("open", resolve); tv.once("error", reject); });
  const playing = nextMessage(viewer, "viewer-state");
  tv.send(JSON.stringify({
    type: "state",
    state: {
      sessionId: "episode-1", sequence: 1, positionSeconds: 42, paused: false,
      playbackRate: 1, mediaUrl: "https://torbox.example/episode.mkv", title: "Episode 1",
    },
  }));
  assert.deepEqual(await playing, {
    type: "viewer-state", mode: "playing", sessionId: "episode-1", title: "Episode 1", paused: false,
  });

  const waiting = nextMessage(viewer, "viewer-state");
  tv.send(JSON.stringify({ type: "idle", sessionId: "episode-1" }));
  assert.deepEqual(await waiting, { type: "viewer-state", mode: "waiting" });
  tv.close();
  viewer.close();
});

test("a viewer returns to waiting when the TV disappears", async () => {
  const coordinator = {
    update: async () => [],
    status: () => ({ itemId: "item-1", state: null }),
  };
  const server = createBridgeServer({ coordinator, tvDisconnectGraceMs: 20 });
  await server.listen(0, "127.0.0.1");
  servers.push(server);
  const port = server.address().port;
  const viewer = new WebSocket(`ws://127.0.0.1:${port}/ws?role=viewer`);
  const initial = nextMessage(viewer, "viewer-state");
  await new Promise((resolve, reject) => { viewer.once("open", resolve); viewer.once("error", reject); });
  await initial;
  const tv = new WebSocket(`ws://127.0.0.1:${port}/ws?role=tv`);
  await new Promise((resolve, reject) => { tv.once("open", resolve); tv.once("error", reject); });
  const playing = nextMessage(viewer, "viewer-state");
  tv.send(JSON.stringify({
    type: "state",
    state: {
      sessionId: "episode-1", sequence: 1, positionSeconds: 1, paused: false,
      mediaUrl: "https://torbox.example/episode.mkv", title: "Episode 1",
    },
  }));
  await playing;
  const waiting = nextMessage(viewer, "viewer-state");
  tv.terminate();
  assert.deepEqual(await waiting, { type: "viewer-state", mode: "waiting" });
  viewer.close();
});

test("the public URL serves the passive viewer and provisions Jellyfin without a login", async () => {
  const viewerSession = {
    serverId: "server-id", userId: "user-id", accessToken: "access-token",
    user: { Id: "user-id", Name: "watchparty" },
  };
  const server = createBridgeServer({
    coordinator: { status: () => null },
    jellyfin: { createViewerSession: async deviceId => ({ ...viewerSession, deviceId }) },
  });
  await server.listen(0, "127.0.0.1");
  servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /Waiting for the TV/);

  const missingDevice = await fetch(`${origin}/api/viewer-session`);
  assert.equal(missingDevice.status, 400);
  const bootstrap = await fetch(`${origin}/api/viewer-session`, {
    headers: { "x-viewer-device-id": "viewer-device-123" },
  });
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(await bootstrap.json(), { ...viewerSession, deviceId: "viewer-device-123" });
});

test("Jellyfin is available only inside the passive shell", async () => {
  const backend = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`jellyfin:${request.url}`);
  });
  await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${backend.address().port}`;
  const server = createBridgeServer({
    coordinator: { status: () => null },
    jellyfin: { createViewerSession: async () => ({}) },
    jellyfinProxy: createJellyfinProxy({ target }),
  });
  await server.listen(0, "127.0.0.1");
  servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;

  const direct = await fetch(`${origin}/web/`, {
    headers: { "sec-fetch-dest": "document" }, redirect: "manual",
  });
  assert.equal(direct.status, 302);
  assert.equal(direct.headers.get("location"), "/");

  const iframe = await fetch(`${origin}/web/`, { headers: { "sec-fetch-dest": "iframe" } });
  assert.equal(await iframe.text(), "jellyfin:/web/");
  await new Promise(resolve => backend.close(resolve));
});

test("a late idle event from the previous episode cannot close the current one", async () => {
  const server = createBridgeServer({
    coordinator: { update: async () => [], status: () => null },
  });
  await server.listen(0, "127.0.0.1");
  servers.push(server);
  const port = server.address().port;
  const tv = new WebSocket(`ws://127.0.0.1:${port}/ws?role=tv`);
  await new Promise((resolve, reject) => { tv.once("open", resolve); tv.once("error", reject); });

  for (const [sessionId, sequence] of [["episode-1", 1], ["episode-2", 1]]) {
    const ack = nextMessage(tv, "ack");
    tv.send(JSON.stringify({
      type: "state",
      state: {
        sessionId, sequence, positionSeconds: 1, paused: false,
        mediaUrl: `https://torbox.example/${sessionId}.mkv`, title: sessionId,
      },
    }));
    await ack;
  }

  const idleAck = nextMessage(tv, "ack-idle");
  tv.send(JSON.stringify({ type: "idle", sessionId: "episode-1" }));
  await idleAck;
  const status = await fetch(`http://127.0.0.1:${port}/status`).then(response => response.json());
  assert.deepEqual(status.viewer, {
    type: "viewer-state", mode: "playing", sessionId: "episode-2", title: "episode-2", paused: false,
  });
  tv.close();
});
