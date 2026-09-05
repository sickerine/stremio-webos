// End-to-end check of bitmap subtitles against a private relay + tv-sim.
// Usage: PORT=3212 CMD=/tmp/ww-tv-cmd-3212 SUB=4 AT=1300.5 node scripts/pw-bitmap.mjs [webkit|chromium] [out.png]
import { chromium, webkit } from "playwright";
import { writeFileSync } from "node:fs";
const [bn = "webkit", out = "/tmp/pw-bitmap.png"] = process.argv.slice(2);
const port = process.env.PORT || 3212, cmd = process.env.CMD || "/tmp/ww-tv-cmd-3212", subN = Number(process.env.SUB || 4);
let at = process.env.AT === "auto" ? null : Number(process.env.AT || 1300.5);   // auto = 0.3s into the track's first block
const b = await (bn === "chromium" ? chromium : webkit).launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on("pageerror", e => console.log("[pageerror]", e.message.slice(0, 200)));
p.on("console", m => { if (m.type() === "error") console.log("[console]", m.text().slice(0, 200)); });
await p.goto(`http://127.0.0.1:${port}/?room=home`);
const poll = async (label, fn, ms = 60000) => { const t0 = Date.now(); for (;;) { const r = await p.evaluate(fn).catch(() => null); if (r) return r; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await p.waitForTimeout(500); } };
console.log("tracks:", JSON.stringify(await poll("subtitle tracks", () => { const s = window.__watch()?.subs; return s?.tracks?.length ? s.tracks : null; })));
await p.evaluate(n => window.__watchSelectSub(n), subN);
if (at == null) { const t0 = Date.now(); for (;;) { const t = await p.evaluate(n => { const m = window.__session()?.bitmap.blocks.get(n); return m?.size ? Math.min(...m.keys()) : null; }, subN); if (t != null) { at = t / 1000 + 0.3; break; } if (Date.now() - t0 > 60000) throw new Error("timeout: first block"); await p.waitForTimeout(500); } console.log("auto AT:", at); }
console.log("bitmap:", JSON.stringify(await poll("bitmap cues", () => { const bm = window.__watch().subs.bitmap; return bm.cues > 0 ? bm : null; }, 90000)));
const playing = await poll("video playing", () => { const w = window.__watch(); return w.video.rs >= 3 && w.video.t > 0 ? { t: w.video.t, rs: w.video.rs, mime: window.__session()?.pipeline?.currentMime } : null; }, 30000).catch(e => null);
console.log("video:", JSON.stringify(playing) || "not playing (browser can't decode this file); pinning currentTime instead");
await p.evaluate(a => { document.body.dataset.at = String(a); }, at);
if (playing) {
  writeFileSync(cmd, `seek ${at}\npause\n`);
  await poll("landed", () => Math.abs(document.querySelector("video").currentTime - Number(document.body.dataset.at)) < 1.5, 45000).catch(e => console.log(e.message));
} else {
  await p.evaluate(a => { Object.defineProperty(document.querySelector("video"), "currentTime", { get: () => a, set() {} }); }, at);
}
await p.evaluate(() => window.__session()?.bitmap.renderNow());
await p.waitForTimeout(800);
const r = await p.evaluate(() => {
  const v = document.querySelector("video"), c = document.querySelector("[data-ass-layer] canvas"), bm = window.__watch().subs.bitmap;
  if (!c) return { t: v.currentTime, canvas: null, bm };
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let opaque = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
  return { t: v.currentTime, canvas: { w: c.width, h: c.height, css: c.style.cssText, opaque }, bm };
});
console.log("result:", JSON.stringify(r));
await p.screenshot({ path: out });
const png = await p.evaluate(() => document.querySelector("[data-ass-layer] canvas")?.toDataURL("image/png"));
if (png) { writeFileSync(out.replace(/\.png$/, "-canvas.png"), Buffer.from(png.split(",")[1], "base64")); console.log("canvas:", out.replace(/\.png$/, "-canvas.png")); }
console.log("screenshot:", out);
await b.close();
