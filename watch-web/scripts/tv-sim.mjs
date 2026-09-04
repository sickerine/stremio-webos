// Pretend to be the TV bridge. Usage:
//   URL=<torrentio-or-cdn-url> POS=250 [PAUSED=1] [PORT=3211] [CMD=/tmp/ww-tv-cmd] node scripts/tv-sim.mjs
// Commands: append a line to the CMD file (default /tmp/ww-tv-cmd); it is read and truncated every 300ms:
//   pause | play | stall | resume | seek <sec> | idle | url <newUrl> [pos]   (stall = 'playing' but position frozen, like a loading TV)
import { WebSocket } from "ws";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const port = process.env.PORT || 3211, cmdFile = process.env.CMD || "/tmp/ww-tv-cmd", room = process.env.ROOM || "home";
let url = process.env.URL, pos = Number(process.env.POS || 0), paused = process.env.PAUSED === "1", stalled = process.env.STALLED === "1", seq = 0, session = Date.now().toString(36);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=tv&room=${room}`);
const state = () => ({ type: "state", state: { sessionId: `sim-${session}`, sequence: ++seq, positionSeconds: pos, paused, playbackRate: 1, buffering: false, mediaUrl: url, title: process.env.TITLE || "tv-sim", episodeId: "sim" } });
const send = () => ws.send(JSON.stringify(state()));
ws.on("open", () => {
  console.log(`[tv-sim] connected, pos=${pos} paused=${paused}`);
  send();
  setInterval(() => { if (!paused && !stalled) pos += 0.5; send(); }, 500);   // 500ms heartbeat like the real TV; `stall` freezes position while 'playing'
  writeFileSync(cmdFile, "");
  setInterval(() => {
    if (!existsSync(cmdFile)) return;
    const text = readFileSync(cmdFile, "utf8"); if (!text.trim()) return; writeFileSync(cmdFile, "");
    for (const line of text.split("\n")) { const c = line.trim(); if (c) handle(c); }
  }, 300);
});
ws.on("message", d => { const m = JSON.parse(d); if (m.type === "error") console.log("[tv-sim] relay error", m); });
ws.on("close", () => { console.log("[tv-sim] relay closed"); process.exit(0); });
function handle(c) {
  if (c === "pause") paused = true; else if (c === "play") paused = false;
  else if (c === "stall") stalled = true; else if (c === "resume") stalled = false;
  else if (c.startsWith("seek ")) pos = Number(c.slice(5));
  else if (c === "idle") { ws.send(JSON.stringify({ type: "idle", sessionId: `sim-${session}` })); console.log("[tv-sim] idle sent"); return; }
  else if (c.startsWith("url ")) { const [u, p] = c.slice(4).trim().split(/\s+/); url = u; if (p) pos = Number(p); session = Date.now().toString(36); seq = 0; }
  send(); console.log(`[tv-sim] ${c} -> pos=${pos.toFixed(1)} paused=${paused} session=${session}`);
}
