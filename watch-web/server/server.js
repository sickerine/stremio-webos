// The only server-side piece: a TV-state relay, a redirect resolver, and static files.
// Movie streams go directly to the CDN; only the short comparison clips live here.
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { bestOffset, INITIAL_CLOCK_SAMPLES, CLOCK_BURST_GAP_MS } from "../shared/clock.js";
import { loginPage } from "./login.js";
import { vlcPage } from "./vlc-page.js";
import sendFile from "send";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
// Watching in VLC on Windows: the follower script as a file a viewer downloads and
// double-clicks. It is a .cmd that runs itself as PowerShell: cmd.exe reads the first
// lines, PowerShell sees them as a comment. (A pasted "download and run" command would be
// shorter, but Windows Defender blocks that shape as a trojan.)
const VLC_FOLLOWER = readFileSync(new URL("./vlc-follow.ps1", import.meta.url), "utf8");
const VLC_FOLLOWER_VERSION = createHash("sha1").update(VLC_FOLLOWER).digest("hex").slice(0, 12);
const vlcLauncher = ({ relay, token, room }) => ["<# :", "@echo off", 'copy /y "%~f0" "%TEMP%\\watch-party-vlc.ps1" >nul',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\\watch-party-vlc.ps1"', "if errorlevel 1 pause", "exit /b", "#>",
  `$Relay = '${relay}'`, `$Token = '${token}'`, `$Room = '${room}'`, `$Version = '${VLC_FOLLOWER_VERSION}'`, VLC_FOLLOWER].join("\n").replace(/\r?\n/g, "\r\n");
const COMPARISON_MEDIA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../comparison-media");
const COMPARISON_FILES = new Set(["dolby-vision.mp4", "hdr10.mp4"]);

export function normalizeState(c, clockOffsetMs = 0, receivedAtMs = Date.now()) {
  if (!c || typeof c !== "object") return null;
  if (typeof c.sessionId !== "string" || !c.sessionId) return null;
  if (!Number.isSafeInteger(c.sequence) || c.sequence < 0) return null;
  if (!Number.isFinite(c.positionSeconds) || c.positionSeconds < 0) return null;
  if (!Number.isFinite(c.sampledAtMs)) return null;
  const mediaUrl = typeof c.mediaUrl === "string" && /^https?:\/\//i.test(c.mediaUrl) ? c.mediaUrl : null;
  return {
    sessionId: c.sessionId, sequence: c.sequence, positionSeconds: c.positionSeconds,
    paused: Boolean(c.paused), buffering: Boolean(c.buffering),
    playbackRate: Number.isFinite(c.playbackRate) && c.playbackRate > 0 ? c.playbackRate : 1,
    durationSeconds: Number.isFinite(c.durationSeconds) ? c.durationSeconds : null,
    mediaUrl,
    title: typeof c.title === "string" ? c.title.slice(0, 300) : "",
    episodeId: typeof c.episodeId === "string" ? c.episodeId.slice(0, 100) : "",
    event: typeof c.event === "string" ? c.event : "heartbeat",
    sampledAtMs: c.sampledAtMs + clockOffsetMs, tvSampledAtMs: c.sampledAtMs, receivedAtMs,
  };
}

// Follow the torrentio -> api.torbox.app -> CDN redirect chain once, server-side,
// because the middle hop sends no CORS header and a page can't follow it. Also
// reports the file size (from Content-Range), which the CDN hides from pages.
export function resolveRedirects(url, { fetchHead = headRequest, maxHops = 6 } = {}) {
  return (async () => {
    let current = url;
    for (let i = 0; i < maxHops; i++) {
      let hop;
      try { hop = await fetchHead(current); }
      catch (e) { const err = new Error(`${new URL(current).host}: ${e.message}`); err.host = new URL(current).host; throw err; }
      const { status, location, size } = hop;
      if (status >= 300 && status < 400 && location) { current = new URL(location, current).href; continue; }
      return { url: current, size: size ?? null };
    }
    return { url: current, size: null };
  })();
}

// "Screenshot" of the TV. webOS draws video on a hardware plane the browser never sees,
// so while something plays we pull that frame from the CDN at the TV's position with
// ffmpeg (tone-mapped to SDR when the stream is HDR). With nothing playing, fall back
// to a page capture over the webOS inspector (dev mode, port 9998): UI only.
const TV_INSPECTOR = process.env.TV_INSPECTOR || "192.168.1.37:9998";
const HDR_TO_SDR = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,";
const run = (cmd, args, ms) => new Promise((ok, bad) => execFile(cmd, args, { timeout: ms, maxBuffer: 64 << 20, encoding: "buffer" }, (e, out, err) => e ? bad(new Error(`${cmd}: ${String(err).trim().split("\n").pop() || e.message}`)) : ok(out)));
async function cdp(host, method, params) {
  const targets = await (await fetch(`http://${host}/json`)).json();
  const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no inspectable page (is the app running?)");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  try {
    await new Promise((ok, bad) => { ws.once("open", ok); ws.once("error", bad); });
    ws.send(JSON.stringify({ id: 1, method, params }));
    const m = await new Promise((ok, bad) => { ws.on("message", d => { const m = JSON.parse(d); if (m.id === 1) ok(m); }); setTimeout(() => bad(new Error("inspector timeout")), 15000); });
    if (m.error) throw new Error(m.error.message);
    return m.result;
  } finally { ws.close(); }
}
// A paused resume (app relaunch, nothing played yet) leaves the panel on the keyframe
// before the reported position, not the exact frame. Ask the page; unreachable = exact.
const tvNeverPlayed = host => cdp(host, "Runtime.evaluate", { expression: "(v=>!!v&&v.played.length===0)(document.querySelector('video'))", returnByValue: true }).then(r => r.result.value === true, () => false);
async function captureTvFrame(room, host) {
  const url = room.cdnUrl || room.state.mediaUrl, s = room.state;
  const pos = s.positionSeconds + (s.paused ? 0 : (Date.now() - s.receivedAtMs) / 1000 * (s.playbackRate || 1));
  const [transfer, snap] = await Promise.all([
    run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_transfer", "-of", "csv=p=0", url], 20000).then(String),
    s.paused && tvNeverPlayed(host),
  ]);
  // Last keyframe at or before pos. ffmpeg's -noaccurate_seek still decodes up to pos on this demuxer, so find it ourselves.
  const keyframes = !snap ? [] : String(await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-read_intervals", `${Math.max(0, pos - 30)}%${pos}`, "-show_entries", "frame=pts_time", "-of", "csv=p=0", url], 30000)).match(/[\d.]+/g)?.map(Number).filter(t => t <= pos) || [];
  const seekTo = keyframes.length ? keyframes[keyframes.length - 1] : pos;
  const vf = "scale=1920:-2," + (/smpte2084|arib-std-b67/.test(transfer) ? HDR_TO_SDR : "") + "format=rgb24";
  return run("ffmpeg", ["-v", "error", "-ss", seekTo.toFixed(3), "-i", url, "-frames:v", "1", "-vf", vf, "-f", "image2pipe", "-c:v", "png", "pipe:1"], 50000);
}

async function captureTvScreenshot(room, host = TV_INSPECTOR) {
  if (room?.state && (room.cdnUrl || room.state.mediaUrl)) return captureTvFrame(room, host);
  const png = await cdp(host, "Page.captureScreenshot", { format: "png" });
  return Buffer.from(png.data, "base64");
}

function headRequest(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.request(url, { method: "GET", headers: { range: "bytes=0-0", "user-agent": "Mozilla/5.0" } }, res => {
      res.resume();
      const m = /\/(\d+)$/.exec(res.headers["content-range"] || "");
      resolve({ status: res.statusCode, location: res.headers.location, size: m ? Number(m[1]) : null });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(new Error("resolve timeout")); });
    req.end();
  });
}

// Optional password gate (WATCH_PASSWORD). One shared password, no usernames; a correct
// POST /login sets a long-lived cookie that every page, API and viewer socket checks.
// /health stays open (docker healthcheck). The TV has no way to log in, so its socket is
// checked against TV_KEY, which the TV sends as ?key= in the relay URL stored on it.
const COOKIE = "watch_auth";
const digest = s => createHash("sha256").update(s).digest();
export function createRelayServer({ resolve = resolveRedirects, tvScreenshot = captureTvScreenshot, distRoot = DIST, comparisonRoot = COMPARISON_MEDIA, staleMs = 6000, password = process.env.WATCH_PASSWORD || "", tvKey = process.env.TV_KEY || "" } = {}) {
  const token = password ? digest(`watch-web cookie:${password}`).toString("hex") : null;
  const authed = req => !token || (req.headers.cookie || "").split(/;\s*/).includes(`${COOKIE}=${token}`);
  const passwordOk = given => typeof given === "string" && timingSafeEqual(digest(given), digest(password));
  const tvKeyOk = given => !tvKey || (typeof given === "string" && timingSafeEqual(digest(given), digest(tvKey)));
  // The address viewers reach this relay at (behind the tunnel the proxy says it was https).
  const publicOrigin = req => {
    const host = req.headers.host || "";
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
    return `${String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" ? "https" : "http"}://${host}`;
  };
  const roomOf = url => { const room = url.searchParams.get("room") || "home"; return /^[a-z0-9_-]{1,64}$/i.test(room) ? room : "home"; };
  const safeNext = n => (typeof n === "string" && /^\/(?!\/)/.test(n) ? n : "/");
  const rooms = new Map();
  const roomFor = id => { if (!rooms.has(id)) rooms.set(id, { clients: new Set(), state: null, cdnUrl: null, size: null, resolving: null, resolveError: null }); return rooms.get(id); };
  const send = (s, m) => { if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(m)); };
  const broadcast = (room, m) => { for (const c of room.clients) send(c, m); };
  // The hashed bundle path in dist/index.html identifies this build. It rides on
  // `hello`, so a tab left open across a deploy reloads instead of running old code.
  let build = null;
  try { build = /\/assets\/index-[\w-]+\.js/.exec(readFileSync(path.join(distRoot, "index.html"), "utf8"))?.[0] ?? null; } catch {}
  const goIdle = (room, event = { sampledAtMs: Date.now(), event: "disconnected" }) => { room.state = null; room.cdnUrl = null; room.size = null; room.resolving = null; room.resolveError = null; broadcast(room, { type: "room-idle", ...event }); };

  // The TV heartbeats every 500ms while it has media. If a room's last sample is
  // older than staleMs the TV is gone (relaunched, crashed, unplugged): its own idle
  // message never comes, because a fresh app instance knows nothing of the old session.
  const sweeper = setInterval(() => {
    for (const [id, room] of rooms) if (room.state && Date.now() - room.state.receivedAtMs > staleMs) { console.log(`[relay] ${id}: no TV heartbeat for ${staleMs}ms, idle`); goIdle(room); }
  }, Math.max(20, staleMs / 3));
  sweeper.unref?.();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, service: "stremio-watch-web" })); return;
    }
    if (token && req.method === "POST" && url.pathname === "/login") {
      let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413); res.end(); return; } }
      const next = safeNext(url.searchParams.get("next"));
      if (passwordOk(new URLSearchParams(body).get("password"))) {
        res.writeHead(303, { location: next, "set-cookie": `${COOKIE}=${token}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax`, "cache-control": "no-store" }); res.end(); return;
      }
      await new Promise(r => setTimeout(r, 500));                      // ponytail: fixed delay, not a per-IP limiter
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(loginPage({ next, error: "That password is not right." })); return;
    }
    if (!authed(req)) {
      if (req.method === "GET" && (req.headers.accept || "").includes("text/html")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(loginPage({ next: url.pathname + url.search })); return; }
      res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ ok: false, error: "password required" })); return;
    }
    if (req.method === "GET" && url.pathname === "/tv/screenshot") {
      const room = [...rooms.values()].find(r => r.state);
      try { const png = await tvScreenshot(room); res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }); res.end(png); }
      catch (e) { res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/vlc") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(vlcPage({ room: roomOf(url), windows: /Windows/.test(req.headers["user-agent"] || "") })); return;
    }
    // The VLC follower for this viewer: this relay's address, the room and the sign-in filled in.
    if (req.method === "GET" && url.pathname === "/vlc.cmd" && publicOrigin(req)) {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="Watch party in VLC.cmd"', "cache-control": "no-store" });
      res.end(vlcLauncher({ relay: publicOrigin(req).replace(/^http/, "ws") + "/ws", token: token || "", room: roomOf(url) })); return;
    }
    if (req.method === "GET" && url.pathname === "/status") {
      const out = {};
      for (const [id, r] of rooms) {
        let tv = 0, viewers = 0; for (const c of r.clients) c.watchRole === "tv" ? tv++ : viewers++;
        out[id] = { tv, viewers, cdnUrl: r.cdnUrl ? r.cdnUrl.replace(/token=[^&]+/, "token=REDACTED") : null, resolveError: r.resolveError, mediaHost: r.state?.mediaUrl ? new URL(r.state.mediaUrl).host : null, state: r.state && { ...r.state, mediaUrl: undefined },
          ...(url.searchParams.has("samples") ? { samples: r.samples || [] } : {}) };   // raw TV samples: [sampledAtMs, position, paused, sequence]
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ ok: true, rooms: out })); return;
    }
    // One file sender handles built assets and the comparison clips, including
    // byte ranges, conditional requests and HEAD for native browser seeking.
    if (req.method === "GET" || req.method === "HEAD") {
      let p = url.pathname, root = distRoot;
      const media = p.startsWith("/comparison/media/");
      if (media) {
        p = p.slice("/comparison/media/".length);
        if (!COMPARISON_FILES.has(p)) { res.writeHead(404); res.end("Not found"); return; }
        root = comparisonRoot;
      } else if (p === "/comparison" || p === "/comparison/") p = "/comparison.html";
      else if (p === "/" || !path.extname(p)) p = "/index.html";
      res.setHeader("cache-control", media ? "private, max-age=3600" : p.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable");
      // Same-origin clips work under the same optional isolation as Watch.
      if (process.env.ISOLATE === "1") {
        res.setHeader("cross-origin-opener-policy", "same-origin");
        res.setHeader("cross-origin-embedder-policy", "require-corp");
      }
      sendFile(req, p, { root, cacheControl: false, dotfiles: "ignore", index: false }).pipe(res);
      return;
    }
    res.writeHead(404); res.end("Not found");
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    const roomId = url.searchParams.get("room") || "home";
    const role = url.searchParams.get("role");
    if (url.pathname !== "/ws" || !/^[a-z0-9_-]{1,64}$/i.test(roomId) || !["tv", "viewer"].includes(role)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return;
    }
    if (role === "tv" ? !tvKeyOk(url.searchParams.get("key")) : !authed(req)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, { roomId, role }));
  });

  wss.on("connection", (socket, { roomId, role }) => {
    const room = roomFor(roomId);
    socket.watchRole = role;
    room.clients.add(socket);
    send(socket, { type: "hello", role, room: roomId, build, follower: VLC_FOLLOWER_VERSION, state: room.state, cdnUrl: room.cdnUrl, size: room.size, resolveError: room.resolveError, resolveHost: room.resolveHost || null });
    let clockOffset = null, clockTimer = null, probeCount = 0, pending = null;
    const clockSamples = [], probes = new Set();
    const probe = () => {
      const t = Date.now(); probes.add(t);
      if (probes.size > 8) probes.delete(probes.values().next().value);
      send(socket, { type: "clock-ping", t });
      clockTimer = setTimeout(probe, ++probeCount < INITIAL_CLOCK_SAMPLES ? CLOCK_BURST_GAP_MS : 10000);
      clockTimer.unref?.();
    };
    socket.on("close", () => { clearTimeout(clockTimer); room.clients.delete(socket); });
    socket.on("message", async data => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return send(socket, { type: "error", code: "invalid-json" }); }
      if (msg.type === "ping") return send(socket, { type: "pong", t: msg.t, serverMs: Date.now() });
      // Viewer diagnostics: the browser's recent CDN requests, so a CDN ban can be read
      // back from `docker logs` without asking the viewer to open devtools.
      if (msg.type === "netlog") { console.log(`[netlog] ${roomId} ${JSON.stringify(msg.data).slice(0, 4000)}`); return; }
      if (role !== "tv") return send(socket, { type: "error", code: "viewer-read-only" });

      if (msg.type === "clock-pong" && probes.delete(msg.t) && Number.isFinite(msg.tvMs)) {
        const now = Date.now();
        clockSamples.push({ rtt: now - msg.t, offset: (msg.t + now) / 2 - msg.tvMs });
        if (clockSamples.length > 8) clockSamples.shift();
        if (clockSamples.length < INITIAL_CLOCK_SAMPLES) return;
        clockOffset = bestOffset(clockSamples);
        if (pending) { const saved = pending; pending = null; acceptEvent(saved.msg, saved.receivedAtMs); }
        return;
      }
      if (msg.type !== "state" && msg.type !== "idle") return;
      const receivedAtMs = Date.now();
      // Keep the latest snapshot until the initial clock-sampling burst completes. Never
      // substitute packet arrival time for the TV's capture time.
      if (clockOffset == null) { pending = { msg, receivedAtMs }; return; }
      acceptEvent(msg, receivedAtMs);
    });
    if (role === "tv") probe();

    function acceptEvent(msg, receivedAtMs) {
      if (msg.type === "idle") {
        if (Number.isFinite(msg.sampledAtMs) && room.state?.sessionId === msg.sessionId &&
            Number.isSafeInteger(msg.sequence) && msg.sequence > room.state.sequence) {
          room.lastEvent = { sessionId: msg.sessionId, sequence: msg.sequence };
          goIdle(room, { sessionId: msg.sessionId, sequence: msg.sequence, event: "idle", sampledAtMs: msg.sampledAtMs + clockOffset, receivedAtMs });
        }
        return;
      }
      if (msg.type !== "state") return;
      const next = normalizeState(msg.state, clockOffset, receivedAtMs);
      if (!next) return send(socket, { type: "error", code: "invalid-state" });
      const prev = room.state;
      if (room.lastEvent?.sessionId === next.sessionId && room.lastEvent.sequence >= next.sequence) return;
      room.lastEvent = { sessionId: next.sessionId, sequence: next.sequence };
      const newSession = !prev || prev.sessionId !== next.sessionId || prev.mediaUrl !== next.mediaUrl;
      room.state = next;
      (room.samples ||= []).push([next.sampledAtMs, next.positionSeconds, next.paused ? 1 : 0, next.sequence]); if (room.samples.length > 120) room.samples.shift();
      if (newSession) { room.cdnUrl = null; room.size = null; room.resolveError = null; broadcast(room, { type: "room-state", state: next, cdnUrl: null }); }
      else broadcast(room, { type: "room-state", state: next, cdnUrl: room.cdnUrl, size: room.size, resolveError: room.resolveError, resolveHost: room.resolveHost || null });

      if (newSession && next.mediaUrl) startResolve(room, next);
    }
  });

  // Resolve with retries: TorBox/torrentio hiccup for a minute fairly often, and the
  // TV keeps playing meanwhile. Keep trying (backing off to 15s) while this session
  // is still the room's current one; viewers see the error text in the meantime.
  function startResolve(room, state) {
    const sessionId = state.sessionId;
    const current = () => room.state?.sessionId === sessionId && room.state?.mediaUrl === state.mediaUrl;
    let attempt = 0;
    const tick = async () => {
      if (!current()) return;
      attempt++;
      try {
        const { url, size } = await resolve(state.mediaUrl);
        if (!current()) return;
        room.cdnUrl = url; room.size = size; room.resolveError = null;
        console.log(`[relay] resolved ${sessionId} -> ${new URL(url).host} (attempt ${attempt})`);
        broadcast(room, { type: "room-media", sessionId, cdnUrl: url, size });
      } catch (error) {
        if (!current()) return;
        room.resolveError = error.message; room.resolveHost = error.host || null;
        console.error(`[relay] resolve failed for ${sessionId} (attempt ${attempt}): ${error.message}`);
        broadcast(room, { type: "room-media", sessionId, cdnUrl: null, size: null, resolveError: error.message, resolveHost: error.host || null, attempt });
        setTimeout(tick, Math.min(15000, 2000 * attempt));
      }
    };
    room.resolving = tick();
  }

  return {
    address: () => httpServer.address(),
    listen: (port, host) => new Promise((ok, bad) => { httpServer.once("error", bad); httpServer.listen(port, host, () => { httpServer.off("error", bad); ok(); }); }),
    close: () => new Promise((ok, bad) => { clearInterval(sweeper); for (const c of wss.clients) c.terminate(); wss.close(); httpServer.close(e => e ? bad(e) : ok()); httpServer.closeAllConnections?.(); }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createRelayServer();
  const port = Number(process.env.PORT || 3211);
  await server.listen(port, "0.0.0.0");
  console.log(`stremio-watch-web relay on http://0.0.0.0:${port} (serving ${DIST})`);
}
