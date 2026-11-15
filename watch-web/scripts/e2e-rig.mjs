// Shared by the end-to-end checks: a file server that honours Range, and a stand-in for the TV.
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createReadStream, existsSync, statSync } from "node:fs";
import { WebSocket } from "ws";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Serves the files in `dir`. `connections` describes what a player opens: how many in all,
// the most at the same time, and for how long more than one was open (the TorBox CDN bans
// an address that keeps several connections pulling at once).
// `firstByteMs` and `bytesPerSecond` make it behave like a distant or slow CDN.
export async function serveMedia(dir, host = "127.0.0.1", { firstByteMs = 0, bytesPerSecond = 0 } = {}) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Range", "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges" };
  const connections = { total: 0, open: 0, mostOpen: 0, overlapMs: 0, longestOverlapMs: 0 };
  let overlapSince = null;
  const count = change => {
    const now = Date.now();
    connections.open += change; connections.mostOpen = Math.max(connections.mostOpen, connections.open);
    if (connections.open > 1 && overlapSince == null) overlapSince = now;
    if (connections.open <= 1 && overlapSince != null) { connections.overlapMs += now - overlapSince; connections.longestOverlapMs = Math.max(connections.longestOverlapMs, now - overlapSince); overlapSince = null; }
  };
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    if (req.url === "/now") { res.writeHead(200, cors); return res.end(String(Date.now())); }   // this machine's clock, for a check that times another machine against it
    // A connection counts from its first request for a file: asking the time is not the player.
    if (!req.socket.counted) { req.socket.counted = true; connections.total++; count(1); req.socket.on("close", () => count(-1)); }
    const file = path.join(dir, path.basename(req.url.split("?")[0]));
    if (!existsSync(file)) { res.writeHead(404, cors); return res.end(); }
    const size = statSync(file).size, m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    const start = m ? Number(m[1]) : 0, end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(m ? 206 : 200, { ...cors, "Content-Type": "video/x-matroska", "Accept-Ranges": "bytes", "Content-Length": end - start + 1, ...(m && { "Content-Range": `bytes ${start}-${end}/${size}` }) });
    if (req.method === "HEAD") return res.end();
    const body = createReadStream(file, { start, end, highWaterMark: 32768 }); res.on("close", () => body.destroy());
    if (!firstByteMs && !bytesPerSecond) return body.pipe(res);
    setTimeout(() => {
      if (!bytesPerSecond) return body.pipe(res);
      body.on("data", chunk => { body.pause(); res.write(chunk, () => setTimeout(() => body.resume(), chunk.length / bytesPerSecond * 1000)); });
      body.on("end", () => res.end());
    }, firstByteMs);
  });
  await new Promise(r => server.listen(0, host, r));
  return { port: server.address().port, connections, close() { server.closeAllConnections(); server.close(); } };
}

// A TCP hop that delivers everything `ms` late, give or take `jitterMs`, in order: a slow
// or uneven path between a viewer and the relay.
export async function delayProxy(port, { ms = 0, jitterMs = 0, host = "0.0.0.0" } = {}) {
  const clients = new Set();
  const server = net.createServer(client => {
    clients.add(client); client.on("close", () => clients.delete(client));
    const upstream = net.connect(port, "127.0.0.1");
    const late = (from, to) => { let last = 0; from.on("data", chunk => { const at = Math.max(Date.now() + ms + (Math.random() * 2 - 1) * jitterMs, last + 1); last = at; setTimeout(() => to.destroyed || to.write(chunk), at - Date.now()); }); from.on("close", () => setTimeout(() => to.destroy(), ms + jitterMs + 5)); from.on("error", () => to.destroy()); };
    late(client, upstream); late(upstream, client);
  });
  await new Promise(r => server.listen(0, host, r));
  // `cut` drops every connection through it, as a network blip does; new ones are taken again at once.
  return { port: server.address().port, cut() { for (const client of clients) client.destroy(); }, close() { server.close(); } };
}

// Connects to the relay at `origin` as the TV and "plays" `mediaUrl` on a clock.
// `key` is the relay's TV_KEY, when it has one. `noiseMs` puts that much error (one standard
// deviation) on each reported position and `lateMs` delays each report by up to that long,
// as a real TV on Wi-Fi does.
export function fakeTv({ origin, room, mediaUrl, title = "", episodeId = "", position = 0, key = "", noiseMs = 0, lateMs = 0 }) {
  const socket = new WebSocket(`${origin.replace("http", "ws")}/ws?role=tv&room=${room}${key ? `&key=${encodeURIComponent(key)}` : ""}`);
  let session = 1, base = position, baseAt = Date.now(), sequence = 0, paused = false, loading = false, rate = 1;
  // Every change of state is kept, so a check can ask where the TV was at any earlier moment.
  const was = [];
  const mark = () => was.push({ at: Date.now(), base, baseAt, rate, moving: !(paused || loading) });
  mark();
  const positionAt = (ms = Date.now()) => { const s = was.findLast(x => x.at <= ms) ?? was[0]; return s.moving ? s.base + (ms - s.baseAt) / 1000 * s.rate : s.base; };
  const hold = () => { base = positionAt(); baseAt = Date.now(); };
  const noise = () => noiseMs ? (Math.random() + Math.random() + Math.random() - 1.5) * 2 * noiseMs / 1000 : 0;   // roughly bell-shaped
  const send = (event = "heartbeat") => {
    if (socket.readyState !== 1) return;
    const text = JSON.stringify({ type: "state", state: { sessionId: `e2e-${room}-${session}`, sequence: ++sequence, positionSeconds: Math.max(0, positionAt() + (paused || loading ? 0 : noise())),
      sampledAtMs: Date.now(), paused, buffering: loading, playbackRate: rate, mediaUrl, title, episodeId, event } });
    if (lateMs) setTimeout(() => socket.readyState === 1 && socket.send(text), Math.random() * lateMs); else socket.send(text);
  };
  socket.on("message", data => { const m = JSON.parse(data); if (m.type === "clock-ping") socket.send(JSON.stringify({ type: "clock-pong", t: m.t, tvMs: Date.now() })); });
  const beat = setInterval(() => send(), 500);
  return {
    ready: new Promise(r => socket.once("open", () => { send("source"); r(); })),
    positionAt,
    setPaused(value) { hold(); paused = value; mark(); send(value ? "pause" : "play"); if (!value) send("playing"); },
    // "Playing" but not advancing, like a TV that is loading.
    setLoading(value) { hold(); loading = value; mark(); send(value ? "waiting" : "playing"); },
    // A skip: the TV loads for `loadingMs` at the new position before it plays on (0: it just jumps).
    async skip(seconds, loadingMs = 300) {
      base = Math.max(0, positionAt() + seconds); baseAt = Date.now();
      if (!loadingMs) { mark(); return send("seeked"); }
      loading = true; mark(); send("seeking"); await sleep(loadingMs); baseAt = Date.now(); loading = false; mark(); send("seeked"); send("playing");
    },
    setRate(value) { hold(); rate = value; mark(); send("ratechange"); },
    // The next episode: a new file is a new session. It loads for `loadingMs` first.
    async open(next, at = 0, loadingMs = 0) {
      ({ mediaUrl, title = "", episodeId = "" } = next); session++; sequence = 0; base = at; baseAt = Date.now(); paused = false; rate = 1; loading = loadingMs > 0; mark(); send("source");
      if (loadingMs) { await sleep(loadingMs); baseAt = Date.now(); loading = false; mark(); send("playing"); }
    },
    idle() { socket.send(JSON.stringify({ type: "idle", sessionId: `e2e-${room}-${session}`, sampledAtMs: Date.now(), sequence: ++sequence })); clearInterval(beat); },
    close() { clearInterval(beat); socket.close(); },
  };
}
