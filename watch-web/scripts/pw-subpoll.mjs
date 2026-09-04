// Select a sub track, let it play, poll until a cue of that track is actively showing,
// then screenshot. Usage: SUB=<n> node scripts/pw-subpoll.mjs [chromium|firefox] [out.png]
import { chromium, firefox } from "playwright";
const [browserName = "chromium", out = "/tmp/pw-subpoll.png"] = process.argv.slice(2);
const subN = Number(process.env.SUB);
const b = await (browserName === "firefox" ? firefox : chromium).launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("http://127.0.0.1:3211/?room=home");
await p.waitForTimeout(13000);
await p.evaluate(n => window.__watchSelectSub(n), subN);
const t0 = Date.now();
let shot = false;
while (Date.now() - t0 < 60000) {
  const info = await p.evaluate(async n => {
    const s = window.__session(); const v = document.querySelector("video"); const j = s.ass.jassub;
    if (!j?.renderer) return { cues: 0 };
    const evs = await j.renderer.getEvents();
    const active = evs.filter(e => v.currentTime * 1000 >= e.Start && v.currentTime * 1000 < e.Start + e.Duration);
    return { cues: evs.length, active: active.map(e => e.Text.slice(0, 40)), t: v.currentTime, stored: (s.ass.events.get(n) || []).length };
  }, subN);
  if (info.active && info.active.length) { console.log("active cue:", JSON.stringify(info)); await p.screenshot({ path: out }); shot = true; break; }
  await p.waitForTimeout(800);
}
if (!shot) console.log("no active cue within 60s");
console.log("screenshot:", out);
await b.close();
