// Shared by the end-to-end checks: a file server that honours Range, and a stand-in for the TV.
import http from "node:http";
import path from "node:path";
import { createReadStream, existsSync, statSync } from "node:fs";
import { WebSocket } from "ws";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Serves the files in `dir`. `connections` describes what a player opens: how many in all,
// the most at the same time, and for how long more than one was open (the TorBox CDN bans
// an address that keeps several connections pulling at once).
export async function serveMedia(dir, host = "127.0.0.1") {
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
    const file = path.join(dir, path.basename(req.url.split("?")[0]));
    if (!existsSync(file)) { res.writeHead(404, cors); return res.end(); }
    const size = statSync(file).size, m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    const start = m ? Number(m[1]) : 0, end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(m ? 206 : 200, { ...cors, "Content-Type": "video/x-matroska", "Accept-Ranges": "bytes", "Content-Length": end - start + 1, ...(m && { "Content-Range": `bytes ${start}-${end}/${size}` }) });
    if (req.method === "HEAD") return res.end();
    const body = createReadStream(file, { start, end }); body.pipe(res); res.on("close", () => body.destroy());
  });
  server.on("connection", socket => { connections.total++; count(1); socket.on("close", () => count(-1)); });
  await new Promise(r => server.listen(0, host, r));
  return { port: server.address().port, connections, close() { server.closeAllConnections(); server.close(); } };
}

// Connects to the relay at `origin` as the TV and "plays" `mediaUrl` on a clock.
// `key` is the relay's TV_KEY, when it has one.
export function fakeTv({ origin, room, mediaUrl, title = "", episodeId = "", position = 0, key = "" }) {
  const socket = new WebSocket(`${origin.replace("http", "ws")}/ws?role=tv&room=${room}${key ? `&key=${encodeURIComponent(key)}` : ""}`);
  let session = 1, base = position, baseAt = Date.now(), sequence = 0, paused = false, loading = false;
  const positionAt = (ms = Date.now()) => (paused || loading ? base : base + (ms - baseAt) / 1000);
  const hold = () => { base = positionAt(); baseAt = Date.now(); };
  const send = (event = "heartbeat") => socket.readyState === 1 && socket.send(JSON.stringify({ type: "state", state: {
    sessionId: `e2e-${room}-${session}`, sequence: ++sequence, positionSeconds: positionAt(), sampledAtMs: Date.now(), paused, buffering: loading, playbackRate: 1,
    mediaUrl, title, episodeId, event } }));
  socket.on("message", data => { const m = JSON.parse(data); if (m.type === "clock-ping") socket.send(JSON.stringify({ type: "clock-pong", t: m.t, tvMs: Date.now() })); });
  const beat = setInterval(() => send(), 500);
  return {
    ready: new Promise(r => socket.once("open", () => { send("source"); r(); })),
    positionAt,
    setPaused(value) { hold(); paused = value; send(value ? "pause" : "play"); if (!value) send("playing"); },
    // "Playing" but not advancing, like a TV that is loading.
    setLoading(value) { hold(); loading = value; send(value ? "waiting" : "playing"); },
    async skip(seconds) { base = positionAt() + seconds; loading = true; send("seeking"); await sleep(300); baseAt = Date.now(); loading = false; send("seeked"); send("playing"); },
    // The next episode: a new file is a new session.
    open(next, at = 0) { ({ mediaUrl, title = "", episodeId = "" } = next); session++; sequence = 0; base = at; baseAt = Date.now(); paused = false; loading = false; send("source"); },
    idle() { socket.send(JSON.stringify({ type: "idle", sessionId: `e2e-${room}-${session}`, sampledAtMs: Date.now(), sequence: ++sequence })); clearInterval(beat); },
    close() { clearInterval(beat); socket.close(); },
  };
}
