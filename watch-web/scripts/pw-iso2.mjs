// Same pipeline data (real header, fonts, processChunk events), but the jassub canvas
// re-homed into <body> instead of the media-controller slot. Separates "placement"
// from "data" as the cause of invisible subtitles.
// Usage: CUE=439.5-443.3 node scripts/pw-iso2.mjs [chromium|firefox] [out.png]
import { chromium, firefox } from "playwright";
const [browserName = "chromium", out = "/tmp/pw-iso2.png"] = process.argv.slice(2);
const browser = await (browserName === "firefox" ? firefox : chromium).launch({ headless: process.env.HEADED !== "1" });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on("console", m => logs.push(`[page:${m.type()}] ${m.text().slice(0, 300)}`));
page.on("worker", w => { w.on("console", m => logs.push(`[worker:${m.type()}] ${m.text().slice(0, 300)}`)); });
await page.goto("http://127.0.0.1:3211/?room=home");
await page.waitForTimeout(9000);
const info = await page.evaluate(async () => {
  const s = window.__session(); if (!s) return "no session";
  await s.ass.hide();
  s.ass.layer = document.body;                 // re-home
  await s.ass.show(3);
  await new Promise(r => setTimeout(r, 1000));
  const c = s.ass.canvas; const r = c.getBoundingClientRect();
  return { ready: s.ass.ready, pushed: s.ass.pushed, size: [c.width, c.height], rect: [r.x | 0, r.y | 0, r.width | 0, r.height | 0], style: c.getAttribute("style"), events: (await s.ass.jassub.renderer.getEvents()).length };
});
console.log("re-homed:", JSON.stringify(info));
if (process.env.CUE) {
  const [a, b] = process.env.CUE.split("-").map(Number); const t0 = Date.now();
  while (Date.now() - t0 < 60000) { const t = await page.evaluate(() => document.querySelector("video")?.currentTime ?? -1); if (t >= a && t <= b) break; await page.waitForTimeout(250); }
  console.log("t at screenshot:", await page.evaluate(() => document.querySelector("video")?.currentTime));
}
await page.screenshot({ path: out });
console.log("=== LOGS ==="); for (const l of [...new Set(logs)]) if (!/FPS:|Content-Range|Illegal/.test(l)) console.log(l);
console.log("screenshot:", out);
await browser.close();
