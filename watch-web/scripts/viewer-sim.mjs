// Pretend to be viewers in a room, for the TV's side of the party: each joins, and for everything the
// TV starts says "loading" at once and "ready" a while later. Usage:
//   [N=2] [READY=6000,12000] [PORT=3211] [ROOM=home] [WATCH_PASSWORD=...] node scripts/viewer-sim.mjs
// READY is how long each takes to load, in ms (the last value repeats; "never" never gets there).
import { WebSocket } from "ws";
import { createHash } from "node:crypto";
const port = process.env.PORT || 3211, room = process.env.ROOM || "home", n = Number(process.env.N || 2);
const takes = (process.env.READY || "6000").split(",");
const cookie = process.env.WATCH_PASSWORD ? `watch_auth=${createHash("sha256").update("watch-web cookie:" + process.env.WATCH_PASSWORD).digest("hex")}` : "";
for (let i = 0; i < n; i++) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=viewer&room=${room}`, { headers: cookie ? { Cookie: cookie } : {} });
  const take = takes[Math.min(i, takes.length - 1)];
  let session = null, timer = null;
  const say = ready => { ws.send(JSON.stringify({ type: "status", sessionId: session, ready })); console.log(`[viewer ${i + 1}] ${ready ? "ready" : "loading"} ${session}`); };
  ws.on("open", () => console.log(`[viewer ${i + 1}] in`));
  ws.on("unexpected-response", (_, res) => { console.log(`[viewer ${i + 1}] refused ${res.statusCode}`); });
  ws.on("message", d => {
    const m = JSON.parse(d);
    const state = m.type === "hello" || m.type === "room-state" ? m.state : null;
    if (m.type === "room-idle") { session = null; clearTimeout(timer); console.log(`[viewer ${i + 1}] the TV stopped`); }
    if (!state || state.sessionId === session) { if (state && i === 0 && state.event !== "heartbeat") console.log(`[tv] ${state.event} at ${state.positionSeconds.toFixed(2)} paused=${state.paused} loading=${state.buffering}`); return; }
    session = state.sessionId; clearTimeout(timer);
    console.log(`[viewer ${i + 1}] the TV has ${state.title || "something"} at ${state.positionSeconds.toFixed(1)} paused=${state.paused}`);
    say(false);
    if (take !== "never") timer = setTimeout(() => say(true), Number(take));
  });
  ws.on("close", () => console.log(`[viewer ${i + 1}] out`));
}
