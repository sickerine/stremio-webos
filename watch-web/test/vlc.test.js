import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { createRelayServer } from "../server/server.js";

const password = "open-sesame", token = createHash("sha256").update(`watch-web cookie:${password}`).digest("hex");
// fetch() will not send a made-up Host header, and the relay builds the follower's address from it.
const get = (port, path, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path, headers }, res => { const parts = []; res.on("data", c => parts.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() })); }).on("error", reject);
});
async function relay(run) {
  const s = createRelayServer({ resolve: async url => ({ url, size: null }), password, tvKey: "" });
  await s.listen(0, "127.0.0.1");
  try { await run(s.address().port); } finally { await s.close(); }
}

// The file carries the sign-in. It must not reach someone who has not given the password.
test("the VLC follower and its page need the password", () => relay(async port => {
  assert.equal((await get(port, "/vlc.cmd")).status, 401);
  assert.equal((await get(port, "/vlc.cmd", { cookie: "watch_auth=wrong" })).status, 401);
  const page = await get(port, "/vlc", { accept: "text/html" });
  assert.ok(!page.body.includes("/vlc.cmd"), "a signed-out visitor gets the password page, not the download");
}));

test("the follower file is made for the viewer who asks: this relay as they reach it, their room, their sign-in", () => relay(async port => {
  const signedIn = { cookie: `watch_auth=${token}` };
  const file = await get(port, "/vlc.cmd?room=den", { ...signedIn, host: "watch.example.test", "x-forwarded-proto": "https" });
  assert.equal(file.status, 200);
  assert.match(file.headers["content-disposition"], /^attachment; filename=".+\.cmd"$/);
  const lines = file.body.split("\r\n");
  assert.ok(!lines.some(line => line.includes("\n")), "cmd.exe needs CRLF line ends throughout");
  assert.deepEqual(lines.slice(0, 2), ["<# :", "@echo off"], "cmd.exe runs the head; PowerShell reads it as a comment");
  assert.ok(lines.includes("$Relay = 'wss://watch.example.test/ws'"), "behind the tunnel the relay is reached over TLS");
  assert.ok(lines.includes("$Room = 'den'"));
  assert.ok(lines.includes(`$Token = '${token}'`));

  const local = (await get(port, "/vlc.cmd?room=" + encodeURIComponent("'; calc; '"), { ...signedIn, host: `127.0.0.1:${port}` })).body.split("\r\n");
  assert.ok(local.includes(`$Relay = 'ws://127.0.0.1:${port}/ws'`));
  assert.ok(local.includes("$Room = 'home'"), "a room name that is not a room name is not written into the script");
  assert.equal((await get(port, "/vlc.cmd", { ...signedIn, host: "evil'; calc; '" })).status, 404, "nor is a Host header that is not a host");

  // The relay tells each follower which version it serves; a file just downloaded must match.
  const hello = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=den&role=viewer`, { headers: signedIn });
    socket.on("message", data => { resolve(JSON.parse(data)); socket.close(); }); socket.on("error", reject);
  });
  assert.ok(hello.follower && lines.includes(`$Version = '${hello.follower}'`));
}));
