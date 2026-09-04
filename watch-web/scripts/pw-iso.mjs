// Isolated jassub render check inside the real page: a fresh JASSUB on a canvas placed
// directly in <body> (outside media-controller), with a plain script and a long event
// covering the current video time. If this does not paint, jassub itself is not drawing.
// Usage: node scripts/pw-iso.mjs [chromium|firefox] [out.png]
import { chromium, firefox } from "playwright";
const [browserName = "chromium", out = "/tmp/pw-iso.png"] = process.argv.slice(2);
const browser = await (browserName === "firefox" ? firefox : chromium).launch({ headless: process.env.HEADED !== "1" });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on("console", m => logs.push(`[page:${m.type()}] ${m.text().slice(0, 300)}`));
page.on("worker", w => { logs.push(`[worker created] ${w.url().split("/").pop()}`); w.on("console", m => logs.push(`[worker:${m.type()}] ${m.text().slice(0, 300)}`)); });
await page.goto("http://127.0.0.1:3211/?room=home");
await page.waitForTimeout(9000);
const res = await page.evaluate(async () => {
  const v = document.querySelector("video");
  const c = document.createElement("canvas");
  Object.assign(c.style, { position: "fixed", left: "40px", top: "40px", width: "800px", height: "300px", zIndex: "99999", border: "2px solid red", background: "rgba(0,0,0,0.3)" });
  document.body.appendChild(c);
  const t0 = Math.floor(v.currentTime || 0);
  const ts = s => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60; return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`; };
  const script = `[Script Info]\nScriptType: v4.00+\nPlayResX: 800\nPlayResY: 300\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,64,&H0000FFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,2,5,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,${ts(0)},${ts(t0 + 3600)},Default,,0,0,0,,ISOLATED JASSUB\n`;
  const J = window.__JASSUB;
  // 1) canvas-only instance driven manually
  const a = new J({ canvas: c, subContent: script });
  let errA = null; try { await a.ready; } catch (e) { errA = String(e); }
  await a.resize(true, 800, 300).catch(e => { errA = errA || String(e); });
  await a.renderer._draw(Math.max(1, v.currentTime || 1), true).catch(e => { errA = errA || String(e); });
  await new Promise(r => setTimeout(r, 800));
  // 2) also try with the video as clock (rVFC) on a second canvas
  const c2 = c.cloneNode(); c2.style.top = "360px"; document.body.appendChild(c2);
  const b = new J({ video: v, canvas: c2, subContent: script });
  let errB = null; try { await b.ready; } catch (e) { errB = String(e); }
  await new Promise(r => setTimeout(r, 1500));
  return { t0, errA, errB, aSize: [c.width, c.height], bSize: [c2.width, c2.height], eventsA: (await a.renderer.getEvents()).length, styles: (await a.renderer.getStyles()).map(s => s.Name) };
});
await page.screenshot({ path: out });
console.log(JSON.stringify(res));
console.log("=== LOGS ==="); for (const l of [...new Set(logs)]) if (!/FPS:/.test(l)) console.log(l);
console.log("screenshot:", out);
await browser.close();
