import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayServer } from "../server/server.js";
import { WebSocket } from "ws";

const wsResult = url => new Promise(r => { const ws = new WebSocket(url); ws.on("open", () => { ws.close(); r("open"); }); ws.on("unexpected-response", (_, res) => { r(res.statusCode); ws.terminate(); }); ws.on("error", () => r("error")); });

// The relay is reachable from the internet. Whoever connects as the TV decides what
// every viewer loads, so that socket must not be open to anyone.
test("with a TV key set, only a client that sends it may act as the TV", async () => {
  const s = createRelayServer({ resolve: async url => ({ url, size: null }), password: "open-sesame", tvKey: "tv-secret" });
  await s.listen(0, "127.0.0.1");
  const ws = `ws://127.0.0.1:${s.address().port}/ws?role=tv&room=home`;
  try {
    assert.equal(await wsResult(ws), 401);
    assert.equal(await wsResult(`${ws}&key=wrong`), 401);
    assert.equal(await wsResult(`${ws}&key=tv-secret`), "open");
    assert.equal(await wsResult(ws.replace("role=tv", "role=viewer") + "&key=tv-secret"), 401);   // the key is not a viewer login
  } finally { await s.close(); }
});
