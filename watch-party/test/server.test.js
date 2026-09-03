import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import WebSocket from "ws";

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
