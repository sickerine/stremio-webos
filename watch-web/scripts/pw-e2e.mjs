// End-to-end check of the watch page in a real browser, with no TV and no CDN: ffmpeg
// makes two short files (stereo AAC, copied as is, and 5.1 Dolby, converted in the
// browser), a relay and a fake TV run in this process, and Chromium has to follow them.
// Needs a build (`npm run build`) and ffmpeg.   Usage: node scripts/pw-e2e.mjs
//   CHROME=<path>  use this browser binary instead of Playwright's own
import http from "node:http";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { chromium } from "playwright";
import { createRelayServer } from "../server/server.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(path.join(tmpdir(), "watch-e2e-"));
const video = ["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=24", "-f", "lavfi", "-i", "sine=f=440:r=48000", "-t", "120",
  "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p"];
const files = { "aac.mkv": ["-c:a", "aac", "-ac", "2"], "dolby.mkv": ["-c:a", "ac3", "-ac", "6"] };
for (const [name, audio] of Object.entries(files)) execFileSync("ffmpeg", ["-v", "error", "-y", ...video, ...audio, path.join(dir, name)]);

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Range", "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges" };
const media = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const file = path.join(dir, path.basename(req.url.split("?")[0]));
  if (!existsSync(file)) { res.writeHead(404, cors); return res.end(); }
  const size = statSync(file).size, m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  const start = m ? Number(m[1]) : 0, end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  res.writeHead(m ? 206 : 200, { ...cors, "Content-Type": "video/x-matroska", "Accept-Ranges": "bytes", "Content-Length": end - start + 1, ...(m && { "Content-Range": `bytes ${start}-${end}/${size}` }) });
  if (req.method === "HEAD") return res.end();
  createReadStream(file, { start, end }).pipe(res);
});
await new Promise(r => media.listen(0, "127.0.0.1", r));
const mediaPort = media.address().port;
const log = console.log; console.log = () => {};          // the relay logs every viewer report
const relay = createRelayServer({ password: "", tvKey: "" });
await relay.listen(0, "127.0.0.1");
const origin = `http://127.0.0.1:${relay.address().port}`;

function fakeTv(room, file, position) {
  const socket = new WebSocket(`${origin.replace("http", "ws")}/ws?role=tv&room=${room}`);
  let base = position, baseAt = Date.now(), sequence = 0, paused = false, loading = false;
  const now = () => (paused || loading ? base : base + (Date.now() - baseAt) / 1000);
  const send = (event = "heartbeat") => socket.readyState === 1 && socket.send(JSON.stringify({ type: "state", state: {
    sessionId: `e2e-${room}`, sequence: ++sequence, positionSeconds: now(), sampledAtMs: Date.now(), paused, buffering: loading, playbackRate: 1,
    mediaUrl: `http://127.0.0.1:${mediaPort}/${file}`, title: file, episodeId: "", event } }));
  socket.on("message", data => { const m = JSON.parse(data); if (m.type === "clock-ping") socket.send(JSON.stringify({ type: "clock-pong", t: m.t, tvMs: Date.now() })); });
  const beat = setInterval(() => send(), 500);
  return {
    ready: new Promise(r => socket.once("open", () => { send("source"); r(); })),
    setPaused(value) { base = now(); baseAt = Date.now(); paused = value; send(value ? "pause" : "play"); if (!value) send("playing"); },
    async skip(seconds) { base = now() + seconds; loading = true; send("seeking"); await sleep(300); baseAt = Date.now(); loading = false; send("seeked"); send("playing"); },
    close() { clearInterval(beat); socket.close(); },
  };
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
const look = page => page.evaluate(() => {
  const v = document.querySelector("video"), overlay = document.querySelector("[data-overlay]"), w = window.__watch();
  return { gap: w.tv ? w.tv.est - v.currentTime : null, readyState: v.readyState, paused: v.paused, audioBytes: v.webkitAudioDecodedByteCount,
    message: overlay.hidden ? "" : overlay.textContent.trim().replace(/\s+/g, " ") };
});
async function inSync(page, seconds, what) {
  let last;
  for (const until = Date.now() + seconds * 1000; Date.now() < until; await sleep(250)) {
    last = await look(page);
    if (last.readyState >= 3 && !last.paused && last.gap != null && Math.abs(last.gap) < 0.3) return last;
  }
  assert.fail(`${what}: not in sync after ${seconds} s: ${JSON.stringify(last)}`);
}

let failed = false;
try {
  for (const file of Object.keys(files)) {
    // Follow the TV, with sound, through a skip.
    const name = path.parse(file).name;
    const room = `play-${name}`, tv = fakeTv(room, file, 20), page = await browser.newPage();
    await tv.ready; await page.goto(`${origin}/?room=${room}`);
    const first = await inSync(page, 30, `${file} start`);
    await sleep(2000);
    assert.ok((await look(page)).audioBytes > first.audioBytes, `${file}: no sound is being decoded`);
    await tv.skip(40); await inSync(page, 20, `${file} after a 40 s skip`);
    tv.close(); await page.close();

    // The TV pauses and resumes again and again while the viewer is still starting.
    const flickerRoom = `flicker-${name}`, flicker = fakeTv(flickerRoom, file, 20), late = await browser.newPage();
    await flicker.ready; await late.goto(`${origin}/?room=${flickerRoom}`);
    for (let i = 0; i < 24; i++) { flicker.setPaused(i % 2 === 0); await sleep(250); }
    flicker.setPaused(false); await inSync(late, 15, `${file} after the TV flickered during start`);
    flicker.close(); await late.close();
    log(`ok  ${file}: plays in sync with sound, follows a skip, survives a flickering start`);
  }
} catch (error) { failed = true; log(`FAIL ${error.message}`); }
finally { await browser.close(); await relay.close(); media.closeAllConnections(); media.close(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
