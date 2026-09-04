// Select a subtitle track, find one of its cues, ask the (separate) TV sim to pause
// there via the command file, wait for the browser to land, screenshot.
// Usage: SUB=<n> CMD=/tmp/ww-tv-cmd node scripts/pw-subat.mjs [chromium|firefox] [out.png]
import { chromium, firefox } from "playwright";
import { writeFileSync } from "node:fs";
const [browserName = "chromium", out = "/tmp/pw-subat.png"] = process.argv.slice(2);
const cmd = process.env.CMD || "/tmp/ww-tv-cmd";
const subN = Number(process.env.SUB);
const b = await (browserName === "firefox" ? firefox : chromium).launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("http://127.0.0.1:3211/?room=home");
await p.waitForTimeout(13000);
await p.evaluate(n => window.__watchSelectSub(n), subN);
await p.waitForTimeout(4000);
// collect cue times for this track, pick one a bit ahead of the current playhead
const pick = await p.evaluate(n => {
  const s = window.__session(); const v = document.querySelector("video");
  const evs = (s.ass.events.get(n) || s.text.tracks.get(n) && [] || []).map(e => e.time / 1000).filter(Boolean).sort((a, b) => a - b);
  const cue = evs.find(t => t > v.currentTime + 4) ?? evs[Math.floor(evs.length / 2)] ?? null;
  return { cue, count: evs.length, t: v.currentTime };
});
console.log("pick:", JSON.stringify(pick));
if (pick.cue) {
  writeFileSync(cmd, `seek ${Math.floor(pick.cue + 0.6)}\npause\n`);
  const target = pick.cue;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) { const t = await p.evaluate(() => document.querySelector("video").currentTime); if (Math.abs(t - target) < 1.5) break; await p.waitForTimeout(300); }
  await p.evaluate(() => { const v = document.querySelector("video"); if (v.paused) window.__session()?.ass.renderNow(); });
  await p.waitForTimeout(600);
}
console.log("t at shot:", await p.evaluate(() => document.querySelector("video").currentTime), "active:", await p.evaluate(() => window.__watch().subs.activeAss));
await p.screenshot({ path: out });
console.log("screenshot:", out);
await b.close();
