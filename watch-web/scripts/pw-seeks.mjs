// What a viewer sees while the TV is sought again and again (someone hunting for a scene after the
// credits): a real browser follows a fake TV through a run of seeks, and every 100 ms where the
// viewer's picture is and where the TV is are written down. A viewer that shows the same stretch
// twice though the TV never went back over it has "looped".
// Needs a build (`npm run build`) and ffmpeg.
//   node scripts/pw-seeks.mjs [clean|early]     CHROME=<path> as in pw-e2e.mjs
//   clean  the TV says "loading" at the new place until its seek has landed, then plays on (what a
//          TV should say)
//   early  the TV says it is playing at the new place at once, and where it really is a while later:
//          behind, by as long as its seek took to land
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createRelayServer } from "../server/server.js";
import { fakeTv, serveMedia } from "./e2e-rig.mjs";

const mode = process.argv[2] || "clean", sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(path.join(tmpdir(), "watch-seeks-"));
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=24", "-f", "lavfi", "-i", "sine=f=440:r=48000", "-t", "300",
  "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", path.join(dir, "a.mkv")]);
const media = await serveMedia(dir);
const log = console.log; console.log = () => {};
const relay = createRelayServer({ password: "", tvKey: "" });
await relay.listen(0, "127.0.0.1");
const origin = `http://127.0.0.1:${relay.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
const tv = fakeTv({ origin, room: "seeks", mediaUrl: `http://127.0.0.1:${media.port}/a.mkv`, title: "a", position: 200 });
const page = await browser.newPage();
await tv.ready; await page.goto(`${origin}/?room=seeks`);
const look = () => page.evaluate(() => { const v = document.querySelector("video"); return { t: v.currentTime, paused: v.paused, rs: v.readyState }; });
for (const until = Date.now() + 30000; Date.now() < until; await sleep(250)) { const l = await look(); if (l.rs >= 3 && !l.paused && Math.abs(tv.positionAt() - l.t) < 0.3) break; }

// the seeks: forward through the ending in steps, back a little, forward again, 1.6 s apart
const steps = [10, 10, 10, -15, 10, 10, -5, 10], landMs = 1200;
const rows = [], began = Date.now();
const sampler = setInterval(async () => { const l = await look().catch(() => null); if (l) rows.push({ at: Date.now() - began, tv: tv.positionAt(), ...l }); }, 100);
await sleep(1500);
const marks = [];
for (const step of steps) {
  marks.push({ at: Date.now() - began, step });
  if (mode === "clean") await tv.skip(step, landMs);
  else { await tv.skip(step, 0); await sleep(landMs); await tv.skip(-landMs / 1000, 0); }      // "playing there" at once; where it landed, later
  await sleep(1600 - landMs);
}
await sleep(6000);
clearInterval(sampler);

// what the viewer showed: each stretch of picture it played, and how much of it it had played before
// since the last seek the TV made
let replayed = 0, backs = 0, seen = [], mark = 0;
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i];
  while (mark < marks.length && marks[mark].at <= b.at) { seen = []; mark++; }          // a seek of the TV's: what was shown before does not count
  if (b.t < a.t - 0.3) backs++;
  if (!b.paused && b.t > a.t && b.t - a.t < 0.5) {
    for (const [s, e] of seen) replayed += Math.max(0, Math.min(e, b.t) - Math.max(s, a.t));
    seen.push([a.t, b.t]);
  }
}
const off = rows.slice(-30).map(r => Math.abs(r.tv - r.t));
log(`${mode}: the viewer went back ${backs} times over ${steps.length} seeks of the TV (${steps.filter(s => s < 0).length} of them backwards), showed ${replayed.toFixed(1)} s of picture twice, and ended ${Math.max(...off).toFixed(2)} s from the TV at most`);
if (process.env.ROWS) for (const r of rows) log(`${String(r.at).padStart(6)} tv ${r.tv.toFixed(2).padStart(7)} viewer ${r.t.toFixed(2).padStart(7)} ${r.paused ? "paused" : "playing"} rs${r.rs}${marks.find(m => Math.abs(m.at - r.at) < 50) ? "   <- the TV is sought " + marks.find(m => Math.abs(m.at - r.at) < 50).step : ""}`);
await browser.close(); await relay.close(); media.close(); tv.close(); rmSync(dir, { recursive: true, force: true });
process.exit(0);
