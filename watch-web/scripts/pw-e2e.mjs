// End-to-end check of the watch page in a real browser, with no TV and no CDN: ffmpeg
// makes three short files (stereo AAC, copied as is; 5.1 Dolby and 5.1 TrueHD, converted
// in the browser), a relay and a fake TV run in this process, and Chromium has to follow them.
// Needs a build (`npm run build`) and ffmpeg.   Usage: node scripts/pw-e2e.mjs
//   CHROME=<path>  use this browser binary instead of Playwright's own
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createRelayServer } from "../server/server.js";
import { fakeTv, serveMedia } from "./e2e-rig.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(path.join(tmpdir(), "watch-e2e-"));
const video = ["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=24", "-f", "lavfi", "-i", "sine=f=440:r=48000", "-t", "120",
  "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p"];
const files = { "aac.mkv": ["-c:a", "aac", "-ac", "2"], "dolby.mkv": ["-c:a", "ac3", "-ac", "6"], "truehd.mkv": ["-c:a", "truehd", "-strict", "-2", "-ac", "6"] };
for (const [name, audio] of Object.entries(files)) execFileSync("ffmpeg", ["-v", "error", "-y", ...video, ...audio, path.join(dir, name)]);

const media = await serveMedia(dir);
const mediaPort = media.port;
const log = console.log; console.log = () => {};          // the relay logs every viewer report
const relay = createRelayServer({ password: "", tvKey: "" });
await relay.listen(0, "127.0.0.1");
const origin = `http://127.0.0.1:${relay.address().port}`;

const tvFor = (room, file) => fakeTv({ origin, room, mediaUrl: `http://127.0.0.1:${mediaPort}/${file}`, title: file, position: 20 });
// What the room is told of its viewers, as the TV app hears it: each `ready` the relay passed on, in order.
import { WebSocket } from "ws";
const roomOf = room => {
  const said = [], socket = new WebSocket(`${origin.replace("http", "ws")}/ws?role=tv&room=${room}`);
  socket.on("message", data => { const m = JSON.parse(data); if ((m.type === "room-viewers" || m.type === "hello") && m.viewers?.length) said.push(m.viewers[0].ready); });
  return { said, close: () => socket.close() };
};

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
    const room = `play-${name}`, tv = tvFor(room, file), heard = roomOf(room), page = await browser.newPage();
    await tv.ready; await page.goto(`${origin}/?room=${room}`);
    const first = await inSync(page, 30, `${file} start`);
    await sleep(2000);
    assert.ok((await look(page)).audioBytes > first.audioBytes, `${file}: no sound is being decoded`);
    // The TV app waits for this: the page says it is loading, then that it can play. (Through a skip
    // into what it has buffered already it can play all along, and says nothing new.)
    assert.deepEqual([heard.said.includes(false), heard.said.at(-1)], [true, true], `${file}: the room heard ${JSON.stringify(heard.said)} of the viewer as it started`);
    await tv.skip(40); await inSync(page, 20, `${file} after a 40 s skip`);
    await sleep(600);
    assert.equal(heard.said.at(-1), true, `${file}: the room heard ${JSON.stringify(heard.said)} of the viewer through a skip`);
    tv.close(); heard.close(); await page.close();

    // The TV pauses and resumes again and again while the viewer is still starting.
    const flickerRoom = `flicker-${name}`, flicker = tvFor(flickerRoom, file), late = await browser.newPage();
    await flicker.ready; await late.goto(`${origin}/?room=${flickerRoom}`);
    for (let i = 0; i < 24; i++) { flicker.setPaused(i % 2 === 0); await sleep(250); }
    flicker.setPaused(false); await inSync(late, 15, `${file} after the TV flickered during start`);
    flicker.close(); await late.close();
    log(`ok  ${file}: plays in sync with sound, follows a skip, survives a flickering start`);
  }
} catch (error) { failed = true; log(`FAIL ${error.message}`); }
finally { await browser.close(); await relay.close(); media.close(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
