import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTvPosition, syncAction, isBuffered } from "../web/src/sync.js";
import { normalizeState, resolveRedirects } from "../server/server.js";
import { ByteSource } from "../web/src/net/byte-source.js";

test("TV position estimate advances only while playing and not buffering", () => {
  const base = { positionSeconds: 100, paused: false, playbackRate: 1, receivedAtMs: 0 };
  assert.equal(estimateTvPosition({ ...base }, 4000), 104);
  assert.equal(estimateTvPosition({ ...base, buffering: true }, 4000), 100);
  assert.equal(estimateTvPosition({ ...base, paused: true }, 4000), 100);
});

test("sync policy: dead band, rate nudge, hard seek", () => {
  assert.equal(syncAction(100, 100.2).type, "none");
  assert.equal(syncAction(100, 101.5).type, "rate");
  assert.equal(syncAction(100, 104).type, "seek");
  assert.ok(isBuffered([[90, 120]], 100));
  assert.ok(!isBuffered([[90, 120]], 130));
});

test("relay rejects garbage state and keeps only http(s) media urls", () => {
  assert.equal(normalizeState(null), null);
  assert.equal(normalizeState({ sessionId: "a", sequence: 1, positionSeconds: -1 }), null);
  const s = normalizeState({ sessionId: "a", sequence: 1, positionSeconds: 5, mediaUrl: "file:///x" });
  assert.equal(s.mediaUrl, null);
  assert.equal(normalizeState({ sessionId: "a", sequence: 1, positionSeconds: 5, mediaUrl: "https://cdn/x.mkv" }).mediaUrl, "https://cdn/x.mkv");
});

test("resolver follows the torrentio -> torbox -> cdn chain and stops at 200", async () => {
  const hops = { "https://torrentio/resolve": { status: 302, location: "https://api.torbox/dl" }, "https://api.torbox/dl": { status: 307, location: "https://cdn/file.mkv?token=k" }, "https://cdn/file.mkv?token=k": { status: 206, size: 1447114629 } };
  const final = await resolveRedirects("https://torrentio/resolve", { fetchHead: async u => hops[u] });
  assert.deepEqual(final, { url: "https://cdn/file.mkv?token=k", size: 1447114629 });
});

test("ByteSource serves arbitrary ranges from 4 MiB-aligned chunk fetches and tees bytes in order", async () => {
  const size = 10 * 1024 * 1024 + 123;
  const file = new Uint8Array(size); for (let i = 0; i < size; i += 4099) file[i] = (i / 4099) & 255;
  let requests = 0;
  const fetchImpl = async (_u, { headers, method } = {}) => {
    requests++;
    if (method === "HEAD" || !headers?.Range) return { ok: true, status: 200, headers: new Headers({ "content-length": String(size) }), body: { cancel: async () => {} } };
    const [, a, b] = /bytes=(\d+)-(\d*)/.exec(headers.Range);
    const start = +a, end = b === "" ? size - 1 : Math.min(+b, size - 1);
    return { status: 206, headers: new Headers({ "content-range": `bytes ${start}-${end}/${size}` }), arrayBuffer: async () => file.slice(start, end + 1).buffer };
  };
  const src = new ByteSource("https://x/f.mkv", { fetchImpl });
  const teed = []; src.setTee({ write: (o, b) => teed.push([o, b.byteLength]) });
  assert.equal(await src.getSize(), size);
  const a = await src.read(4 * 1024 * 1024 - 10, 4 * 1024 * 1024 + 10);      // straddles a chunk boundary
  assert.equal(a.byteLength, 20);
  assert.deepEqual([...a], [...file.subarray(4 * 1024 * 1024 - 10, 4 * 1024 * 1024 + 10)]);
  const b = await src.read(100, 200);                                          // served from cache
  assert.deepEqual([...b], [...file.subarray(100, 200)]);
  assert.ok(requests <= 1 + 2 + 2, `too many requests: ${requests}`);        // size probe + 2 chunks + prefetch
  const offsets = teed.map(t => t[0]).sort((x, y) => x - y);
  assert.deepEqual(offsets.slice(0, 2), [0, 4 * 1024 * 1024], "tee received the two needed chunks");
});
