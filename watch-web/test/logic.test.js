import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTvPosition, syncAction, isBuffered } from "../web/src/sync.js";
import { bestOffset } from "../shared/clock.js";
import { normalizeState, resolveRedirects, createRelayServer } from "../server/server.js";
import { WebSocket } from "ws";
import { ByteSource } from "../web/src/net/byte-source.js";

test("TV position estimate advances only while playing and not buffering", () => {
  const base = { positionSeconds: 100, paused: false, playbackRate: 1, sampledAtMs: 0 };
  assert.equal(estimateTvPosition({ ...base }, 4000), 104);
  assert.equal(estimateTvPosition({ ...base, buffering: true }, 4000), 100);
  assert.equal(estimateTvPosition({ ...base, paused: true }, 4000), 100);
});

test("sync policy: dead band, rate nudge, hard seek", () => {
  assert.equal(syncAction(100, 100.2).type, "none");
  assert.equal(syncAction(100, 101.5).type, "rate");
  assert.equal(syncAction(100, 104).type, "seek");
  // paused or just-jumped: land on the frame, don't nudge
  assert.equal(syncAction(100, 100.2, { paused: true }).type, "seek");
  assert.equal(syncAction(100, 100.05, { paused: true }).type, "none");
  assert.equal(syncAction(100, 101.5, { snap: true }).type, "seek");
  assert.equal(syncAction(100, 100.2, { snap: true }).type, "none");     // playing: tolerate TV clock jitter after a seek
  assert.equal(syncAction(100, 100.2, { paused: true }).type, "seek");   // paused: land on the frame
  // clock sync trusts the fastest ping
  assert.equal(bestOffset([{ rtt: 40, offset: 10 }, { rtt: 12, offset: 3 }, { rtt: 90, offset: -20 }]), 3);
  assert.equal(bestOffset([]), null);
  assert.ok(isBuffered([[90, 120]], 100));
  assert.ok(!isBuffered([[90, 120]], 130));
});

test("relay rejects garbage state and keeps only http(s) media urls", () => {
  assert.equal(normalizeState(null), null);
  assert.equal(normalizeState({ sessionId: "a", sequence: 1, sampledAtMs: Date.now(), positionSeconds: -1 }), null);
  const s = normalizeState({ sessionId: "a", sequence: 1, sampledAtMs: Date.now(), positionSeconds: 5, mediaUrl: "file:///x" });
  assert.equal(s.mediaUrl, null);
  assert.equal(normalizeState({ sessionId: "a", sequence: 1, sampledAtMs: Date.now(), positionSeconds: 5, mediaUrl: "https://cdn/x.mkv" }).mediaUrl, "https://cdn/x.mkv");
});

test("resolver follows the torrentio -> torbox -> cdn chain and stops at 200", async () => {
  const hops = { "https://torrentio/resolve": { status: 302, location: "https://api.torbox/dl" }, "https://api.torbox/dl": { status: 307, location: "https://cdn/file.mkv?token=k" }, "https://cdn/file.mkv?token=k": { status: 206, size: 1447114629 } };
  const final = await resolveRedirects("https://torrentio/resolve", { fetchHead: async u => hops[u] });
  assert.deepEqual(final, { url: "https://cdn/file.mkv?token=k", size: 1447114629 });
});

test("ByteSource streams sequential reads over one Range request and tees bytes in order", async () => {
  const size = 60 * 1024 * 1024 + 123;                                        // 15 chunks: the tail read below is a real seek
  const file = new Uint8Array(size); for (let i = 0; i < size; i += 4099) file[i] = (i / 4099) & 255;
  const ranges = [];
  const fetchImpl = async (_u, { headers, method, signal } = {}) => {
    if (method === "HEAD" || !headers?.Range) return { ok: true, status: 200, headers: new Headers({ "content-length": String(size) }), body: { cancel: async () => {} } };
    const [, a, b] = /bytes=(\d+)-(\d*)/.exec(headers.Range);
    const start = +a, end = b === "" ? size - 1 : Math.min(+b, size - 1);
    ranges.push(headers.Range);
    // stream the body in 1 MiB pieces so chunk boundaries fall mid-read
    let pos = start;
    const body = new ReadableStream({ pull(c) { if (signal?.aborted) return c.error(new Error("aborted")); if (pos > end) return c.close(); const n = Math.min(1 << 20, end + 1 - pos); c.enqueue(file.slice(pos, pos + n)); pos += n; } });
    return new Response(body, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${size}` } });
  };
  const src = new ByteSource("https://x/f.mkv", { fetchImpl });
  const teed = []; src.setTee({ write: (o, b) => teed.push([o, b.byteLength]) });
  assert.equal(await src.getSize(), size);
  const a = await src.read(4 * 1024 * 1024 - 10, 4 * 1024 * 1024 + 10);      // straddles a chunk boundary
  assert.equal(a.byteLength, 20);
  assert.deepEqual([...a], [...file.subarray(4 * 1024 * 1024 - 10, 4 * 1024 * 1024 + 10)]);
  const b = await src.read(100, 200);                                          // served from cache
  assert.deepEqual([...b], [...file.subarray(100, 200)]);
  const c = await src.read(6 * 1024 * 1024, 6 * 1024 * 1024 + 5);              // still sequential: rides the same stream
  assert.deepEqual([...c], [...file.subarray(6 * 1024 * 1024, 6 * 1024 * 1024 + 5)]);
  assert.deepEqual(ranges, ["bytes=0-"], "one open-ended request served everything so far");
  const tail = await src.read(size - 5, size);                                 // a seek: new stream, final partial chunk
  assert.deepEqual([...tail], [...file.subarray(size - 5)]);
  assert.equal(ranges.length, 2);
  const offsets = teed.map(t => t[0]).sort((x, y) => x - y);
  assert.deepEqual(offsets.slice(0, 2), [0, 4 * 1024 * 1024], "tee received the chunks in file order");
  src.dispose();
});

test("ByteSource bounds requests and cache while reading across windows and the final partial chunk", async () => {
  const file = Uint8Array.from({ length: 1031 }, (_, i) => i % 251);
  const ranges = [];
  const src = new ByteSource("https://x/file", { size: file.length, chunkSize: 32, maxCachedChunks: 3, rangeBytes: 128, prefetchAhead: 0,
    fetchImpl: async (_url, { headers }) => {
      const [, a, b] = /bytes=(\d+)-(\d*)/.exec(headers.Range);
      assert.notEqual(b, "", "every response must have a bounded length");
      const start = +a, end = +b;
      assert.ok(end - start + 1 <= 128);
      ranges.push([start, end]);
      return new Response(file.slice(start, end + 1), { status: 206 });
    },
  });
  try {
    for (let i = 0; i < file.length; i += 17) {
      assert.deepEqual(await src.read(i, Math.min(i + 17, file.length)), file.slice(i, i + 17));
      assert.ok(src.order.length <= 3, "resolved cache stays within its budget");
    }
    assert.equal(ranges.length, 9, "window boundaries continue without extra seek requests");
    assert.equal(src.retries, 0, "a completed window is not a short read");
  } finally { src.dispose(); }
});

test("relay marks a room idle when the TV stops heartbeating", async () => {
  const server = createRelayServer({ resolve: async url => ({ url, size: null }), staleMs: 120 });
  await server.listen(0, "127.0.0.1");
  const base = `ws://127.0.0.1:${server.address().port}/ws?room=t`;
  const open = url => new Promise(ok => { const s = new WebSocket(url); s.on("message", data => { const m = JSON.parse(data); if (m.type === "clock-ping") s.send(JSON.stringify({ type: "clock-pong", t: m.t, tvMs: Date.now() })); }); s.on("open", () => ok(s)); });
  const tv = await open(`${base}&role=tv`);
  tv.send(JSON.stringify({ type: "state", state: { sessionId: "s1", sequence: 1, sampledAtMs: Date.now(), positionSeconds: 5, mediaUrl: "http://x/y.mkv" } }));
  await new Promise(r => setTimeout(r, 30));
  const viewer = await open(`${base}&role=viewer`);
  const got = [];
  viewer.on("message", d => got.push(JSON.parse(d.toString()).type));
  tv.close();                                           // TV app relaunched: no idle message ever comes
  await new Promise(r => setTimeout(r, 400));
  assert.ok(got.includes("room-idle"), `expected room-idle, got ${got}`);
  viewer.close();
  await server.close();
});


test("TV capture time survives both network hops and different clocks for every timeline event", () => {
  const capturedAt = 100000, tvOffset = 60000, viewerOffset = -30000;
  const transit = 750;
  for (const event of ["play", "pause", "seeking", "seeked", "ratechange", "waiting", "playing", "ended", "source", "heartbeat"]) {
    const paused = event === "pause" || event === "ended";
    const buffering = event === "waiting" || event === "seeking";
    const s = normalizeState({ sessionId: "s", sequence: 1, event, sampledAtMs: capturedAt + tvOffset,
      positionSeconds: 42, paused, buffering, playbackRate: 2 }, -tvOffset, capturedAt + 250);
    assert.equal(s.sampledAtMs, capturedAt);
    assert.equal(s.receivedAtMs, capturedAt + 250);
    const local = { ...s, sampledAtMs: s.sampledAtMs + viewerOffset };
    assert.equal(estimateTvPosition(local, capturedAt + viewerOffset + transit), paused || buffering ? 42 : 43.5, event);
  }
  assert.equal(normalizeState({ sessionId: "s", sequence: 1, positionSeconds: 1 }), null, "arrival time must not silently replace a missing capture time");
  assert.equal(syncAction(41, 42, { playbackRate: 2 }).playbackRate, 2.12);
  assert.equal(syncAction(41.6, 42, { snap: true }).type, "seek");
  assert.equal(syncAction(41.6, 42).type, "rate", "subsequent heartbeats nudge instead of repeating the event seek");
});

test("relay calibrates the TV clock and rejects stale state after a timestamped stop", async () => {
  const server = createRelayServer({ password: "", resolve: async url => ({ url, size: 1 }) });
  await server.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${server.address().port}`;
  const tv = new WebSocket(base.replace("http:", "ws:") + "/ws?room=t&role=tv");
  const tvSkew = 60000;
  tv.on("message", data => { const m = JSON.parse(data); if (m.type === "clock-ping") tv.send(JSON.stringify({ type: "clock-pong", t: m.t, tvMs: Date.now() + tvSkew })); });
  await new Promise(resolve => tv.once("open", resolve));
  const state = { sessionId: "s", sequence: 1, positionSeconds: 12, sampledAtMs: Date.now() + tvSkew - 1000, event: "play", mediaUrl: "https://fixture/video" };
  const read = async () => (await (await fetch(base + "/status")).json()).rooms.t.state;
  try {
    tv.send(JSON.stringify({ type: "state", state }));
    let received;
    for (let i = 0; i < 50; i++) { received = await read(); if (received) break; await new Promise(r => setTimeout(r, 20)); }
    assert.ok(received, "clock exchange releases the pending state");
    assert.ok(Math.abs(received.sampledAtMs - (state.sampledAtMs - tvSkew)) < 200);
    assert.ok(received.receivedAtMs - received.sampledAtMs > 800, "the timestamp retains time spent before relay arrival");
    tv.send(JSON.stringify({ type: "idle", sessionId: "s", sequence: 2, sampledAtMs: Date.now() + tvSkew }));
    tv.send(JSON.stringify({ type: "state", state }));
    // A ping/pong is a processing barrier for both preceding WebSocket messages.
    await new Promise(resolve => { const listener = data => { if (JSON.parse(data).type === "pong") { tv.off("message", listener); resolve(); } }; tv.on("message", listener); tv.send(JSON.stringify({ type: "ping", t: Date.now() })); });
    assert.equal(await read(), null, "a delayed pre-stop sample cannot restart the room");
  } finally { tv.close(); await server.close(); }
});
