// Live cold-start probe. Not a unit test: it talks to real TorBox + ffmpeg.
// Usage: node test/e2e-cold-start.mjs "<mediaUrl>" [positionSeconds]
import { WebSocket } from "ws";
import { createWatchLiteServer } from "../src/server.js";

const mediaUrl = process.argv[2];
const position = Number(process.argv[3] || 250);
if (!mediaUrl) { console.error("need a media url"); process.exit(1); }

const server = createWatchLiteServer({ mediaRoot: "/tmp/watch-lite-e2e" });
await server.listen(0, "127.0.0.1");
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

let masterUrl = null;
let dirBase = null;

const viewer = new WebSocket(`ws://127.0.0.1:${port}/ws?role=viewer&room=home`);
viewer.on("message", raw => {
  const m = JSON.parse(raw);
  if (m.type === "media-state" && m.media?.status === "ready" && !masterUrl) {
    masterUrl = base + m.media.playbackUrl;
    dirBase = masterUrl.replace(/master\.m3u8$/, "");
    console.log(`[${stamp()}] media READY  offset=${m.media.offsetSeconds}s`);
  }
});

const tv = new WebSocket(`ws://127.0.0.1:${port}/ws?role=tv&room=home`);
tv.on("open", () => {
  console.log(`[${stamp()}] TV sends state (pos=${position}s)`);
  tv.send(JSON.stringify({ type: "state", state: {
    sessionId: "e2e-1", sequence: 1, positionSeconds: position, paused: false,
    playbackRate: 1, buffering: false, mediaUrl, title: "cold-start test",
  }}));
});

async function text(u) { const r = await fetch(u).catch(() => null); return r?.ok ? r.text() : null; }

async function pollSegment() {
  const pl = await text(dirBase + "stream_0.m3u8");
  const seg = pl?.split("\n").find(l => l.trim().endsWith(".ts"));
  if (!seg) return;
  const res = await fetch(dirBase + seg.trim(), { headers: { range: "bytes=0-1023" } }).catch(() => null);
  if (res?.ok || res?.status === 206) { console.log(`[${stamp()}] FIRST VIDEO SEGMENT playable (${seg.trim()})`); firstSeg = true; }
}

async function pollSub() {
  const master = await text(masterUrl);
  if (!master?.includes("stream_0_vtt.m3u8")) { firstSub = true; noSubs = true; return; } // no sub track in file
  const pl = await text(dirBase + "stream_0_vtt.m3u8");
  const seg = pl?.split("\n").find(l => l.trim().endsWith(".vtt"));
  if (!seg) return;
  const body = await text(dirBase + seg.trim());
  const cues = (body?.match(/-->/g) || []).length;
  if (cues > 0) { console.log(`[${stamp()}] SUBTITLE SEGMENT ready (${cues} cues in ${seg.trim()})`); firstSub = true; }
}

let firstSeg = false, firstSub = false, noSubs = false;
const timer = setInterval(async () => {
  if (!masterUrl) return;
  if (!firstSeg) await pollSegment();
  if (!firstSub) await pollSub();
  if (firstSeg && firstSub) {
    clearInterval(timer);
    console.log(`\nCOLD START: video + ${noSubs ? "no subs in file" : "subtitles"} both ready.`);
    await server.close();
    process.exit(0);
  }
}, 300);

setTimeout(async () => { console.log("timeout at 60s"); await server.close(); process.exit(1); }, 60000);
