import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayServer } from "../server/server.js";
import { WebSocket } from "ws";

// A socket that keeps what it was sent and can wait for a message.
const join = url => new Promise((ok, bad) => {
  const ws = new WebSocket(url), got = [], waiters = [];
  ws.on("message", d => {
    const m = JSON.parse(d); got.push(m);
    if (m.type === "clock-ping") ws.send(JSON.stringify({ type: "clock-pong", t: m.t, tvMs: Date.now() }));
    for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.ok(m); }
  });
  ws.on("error", bad);
  ws.on("open", () => ok({
    ws, got,
    say: m => ws.send(JSON.stringify(m)),
    next: (test, ms = 2000) => new Promise((ok, bad) => { const w = { test, ok }; waiters.push(w); setTimeout(() => bad(new Error("nothing came")), ms).unref(); }),
    leave: () => new Promise(r => { ws.on("close", r); ws.close(); }),
  }));
});
const state = (sessionId, sequence) => ({ type: "state", state: { sessionId, sequence, sampledAtMs: Date.now(), positionSeconds: 10, paused: true, mediaUrl: "https://cdn.example/a.mkv" } });
const readies = m => m.viewers.map(v => v.ready);

// The TV draws who is in the room and, as something starts, waits for them: so it is told of each
// viewer, and whether that viewer can play what the TV has now.
test("the TV is told who is watching and who can play what it has", async () => {
  const s = createRelayServer({ resolve: async url => ({ url, size: 1 }), password: "", tvKey: "" });
  await s.listen(0, "127.0.0.1");
  const at = role => `ws://127.0.0.1:${s.address().port}/ws?role=${role}&room=home`;
  try {
    const tv = await join(at("tv"));
    const hello = await tv.next(m => m.type === "hello").catch(() => tv.got.find(m => m.type === "hello"));
    assert.deepEqual(hello.viewers, [], "an empty room");

    const a = await join(at("viewer"));
    assert.deepEqual(readies(await tv.next(m => m.type === "room-viewers")), [null], "one viewer, who has not said yet");
    const b = await join(at("viewer"));
    assert.deepEqual(readies(await tv.next(m => m.type === "room-viewers" && m.viewers.length === 2)), [null, null]);

    tv.say(state("one", 1));
    await a.next(m => m.type === "room-state" && m.state.sessionId === "one");
    a.say({ type: "status", sessionId: "one", ready: false });
    assert.deepEqual(readies(await tv.next(m => m.type === "room-viewers")), [false, null], "loading");
    a.say({ type: "status", sessionId: "one", ready: true });
    assert.deepEqual(readies(await tv.next(m => m.type === "room-viewers")), [true, null], "and in");

    // something else starts: what a viewer said of the last thing says nothing of this one
    const told = tv.next(m => m.type === "room-viewers");
    tv.say(state("two", 1));
    assert.deepEqual(readies(await told), [false, null]);
    a.say({ type: "status", sessionId: "one", ready: true });        // (a late word about the last one)
    a.say({ type: "status", sessionId: "two", ready: true });
    assert.deepEqual(readies(await tv.next(m => m.type === "room-viewers")), [true, null]);

    const gone = tv.next(m => m.type === "room-viewers" && m.viewers.length === 1);
    await a.leave();
    assert.deepEqual(readies(await gone), [null], "and one who leaves is gone from it");
    await b.leave(); tv.ws.terminate();
  } finally { await s.close(); }
});

// A viewer that says its status over and over does not have the room told each time.
test("a flood of statuses is one word to the room", async () => {
  const s = createRelayServer({ resolve: async url => ({ url, size: 1 }), password: "", tvKey: "" });
  await s.listen(0, "127.0.0.1");
  const at = role => `ws://127.0.0.1:${s.address().port}/ws?role=${role}&room=home`;
  try {
    const tv = await join(at("tv")), v = await join(at("viewer"));
    tv.say(state("one", 1));
    await v.next(m => m.type === "room-state");
    await new Promise(r => setTimeout(r, 300));
    const before = tv.got.filter(m => m.type === "room-viewers").length;
    for (let i = 0; i < 400; i++) v.say({ type: "status", sessionId: "one", ready: i % 2 === 0 });
    await new Promise(r => setTimeout(r, 500));
    const told = tv.got.filter(m => m.type === "room-viewers").length - before;
    assert.ok(told >= 1 && told <= 6, `the room was told ${told} times of 400 statuses`);
    assert.deepEqual(readies(tv.got.filter(m => m.type === "room-viewers").pop()), [false], "and knows the last of them");
    tv.ws.terminate(); v.ws.terminate();
  } finally { await s.close(); }
});

// A viewer still may not act as the TV.
test("a viewer's status is all a viewer may say", async () => {
  const s = createRelayServer({ resolve: async url => ({ url, size: 1 }), password: "", tvKey: "" });
  await s.listen(0, "127.0.0.1");
  try {
    const v = await join(`ws://127.0.0.1:${s.address().port}/ws?role=viewer&room=home`);
    v.say(state("mine", 1));
    assert.equal((await v.next(m => m.type === "error")).code, "viewer-read-only");
    v.ws.terminate();
  } finally { await s.close(); }
});
