import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayServer } from "../server/server.js";
import { WebSocket } from "ws";

const start = async opts => { const s = createRelayServer({ resolve: async url => ({ url, size: null }), staleMs: 120, ...opts }); await s.listen(0, "127.0.0.1"); return { s, base: `http://127.0.0.1:${s.address().port}` }; };
const wsResult = url => new Promise(r => { const ws = new WebSocket(url); ws.on("open", () => { ws.close(); r("open"); }); ws.on("unexpected-response", (_, res) => { r(res.statusCode); ws.terminate(); }); ws.on("error", e => r(`error ${e.message}`)); });

test("password gate: login page, cookie, 401s, TV socket exempt", async () => {
  const { s, base } = await start({ password: "open-sesame" });
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const page = await fetch(`${base}/?room=home`, { headers: { accept: "text/html,*/*" } });
    assert.equal(page.status, 200); assert.match(await page.text(), /type="password"/);
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/assets/index-x.js`)).status, 401);
    assert.equal(await wsResult(`${base.replace("http", "ws")}/ws?role=viewer&room=home`), 401);
    assert.equal(await wsResult(`${base.replace("http", "ws")}/ws?role=tv&room=home`), "open");

    const bad = await fetch(`${base}/login?next=/?room=home`, { method: "POST", body: "password=nope", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
    assert.equal(bad.status, 401); assert.equal(bad.headers.get("set-cookie"), null);
    const ok = await fetch(`${base}/login?next=/?room=home`, { method: "POST", body: "password=open-sesame", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
    assert.equal(ok.status, 303); assert.equal(ok.headers.get("location"), "/?room=home");
    const cookie = ok.headers.get("set-cookie"); assert.match(cookie, /^watch_auth=[0-9a-f]{64}; Path=\/; Max-Age=315360000; HttpOnly; SameSite=Lax$/);
    const c = cookie.split(";")[0];
    assert.equal((await fetch(`${base}/status`, { headers: { cookie: c } })).status, 200);
    const authedWs = await new Promise(r => { const ws = new WebSocket(`${base.replace("http", "ws")}/ws?role=viewer&room=home`, { headers: { cookie: c } }); ws.on("open", () => { ws.close(); r("open"); }); ws.on("unexpected-response", (_, res) => r(res.statusCode)); });
    assert.equal(authedWs, "open");
    // open redirects are not allowed
    const evil = await fetch(`${base}/login?next=//evil.example`, { method: "POST", body: "password=open-sesame", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
    assert.equal(evil.headers.get("location"), "/");
  } finally { await s.close(); }
});

test("no password configured: everything stays open", async () => {
  const { s, base } = await start({ password: "" });
  try { assert.equal((await fetch(`${base}/status`)).status, 200); assert.equal(await wsResult(`${base.replace("http", "ws")}/ws?role=viewer&room=home`), "open"); }
  finally { await s.close(); }
});
