// Playwright diagnostic run: captures PAGE and WORKER console (libass logs live in the
// jassub worker), waits (or waits until the video is inside a cue window), dumps
// player state, screenshots.
// Usage: node scripts/pw-diag.mjs <url> [waitSeconds] [chromium|firefox] [out.png]
//   env CUE=439.5-443.3   poll video.currentTime until inside this range (max 60s) before the screenshot
//   env HEADED=1          show the browser window
//   env ARGS="--a --b"    extra browser args
//   env STATE=0           don't print the state dump
import { chromium, firefox } from "playwright";
const [url = "http://127.0.0.1:3211/?room=home", waitS = "15", browserName = "chromium", out = "/tmp/pw-diag.png"] = process.argv.slice(2);
const args = (process.env.ARGS || "").split(/\s+/).filter(Boolean);
const browser = await (browserName === "firefox" ? firefox : chromium).launch({ headless: process.env.HEADED !== "1", args });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on("console", m => logs.push(`[page:${m.type()}] ${m.text().slice(0, 300)}`));
page.on("pageerror", e => logs.push(`[page:error] ${e.message}`));
page.on("worker", w => {
  logs.push(`[worker created] ${w.url().split("/").pop()}`);
  w.on("console", m => logs.push(`[worker:${m.type()}] ${m.text().slice(0, 300)}`));
  w.on("close", () => logs.push(`[worker closed] ${w.url().split("/").pop()}`));
});
await page.goto(url);
await page.waitForTimeout(Number(waitS) * 1000);
if (process.env.CUE) {
  const [a, b] = process.env.CUE.split("-").map(Number);
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const t = await page.evaluate(() => document.querySelector("video")?.currentTime ?? -1);
    if (t >= a && t <= b) break;
    await page.waitForTimeout(250);
  }
  console.log("video t at screenshot:", await page.evaluate(() => document.querySelector("video")?.currentTime));
}
const state = await page.evaluate(() => { try { return window.__watch?.(); } catch (e) { return String(e); } }).catch(e => String(e));
await page.screenshot({ path: out });
if (process.env.STATE !== "0") { console.log("=== STATE ==="); console.log(JSON.stringify(state, null, 1).slice(0, 3000)); }
console.log("=== LOGS ==="); for (const l of [...new Set(logs)]) if (!/FPS:/.test(l)) console.log(l);
console.log("screenshot:", out);
await browser.close();
