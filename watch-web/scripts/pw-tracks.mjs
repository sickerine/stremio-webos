// Dump detected tracks, then optionally switch audio/sub and screenshot.
// Usage: node scripts/pw-tracks.mjs [chromium|firefox] [waitS]
//   env AUDIO=<id>  switch to this audio track id, then screenshot /tmp/pw-audio.png
//   env SUB=<n>     switch to this subtitle track number, then screenshot /tmp/pw-sub.png
import { chromium, firefox } from "playwright";
const [browserName = "chromium", waitS = "14"] = process.argv.slice(2);
const b = await (browserName === "firefox" ? firefox : chromium).launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on("pageerror", e => console.log("[err]", e.message.slice(0, 160)));
await p.goto("http://127.0.0.1:3211/?room=home");
await p.waitForTimeout(Number(waitS) * 1000);
const w = await p.evaluate(() => window.__watch());
console.log("video:", w.tracks.video.codec, w.tracks.video.codecString, "hdr", w.tracks.video.hdr);
console.log("audios:", JSON.stringify(w.tracks.audios));
console.log("subs:", JSON.stringify(w.subs.tracks));
console.log("selectedAudio:", w.selectedAudio, "selectedSub:", w.subs.selected);
if (process.env.AUDIO) {
  const before = await p.evaluate(() => document.querySelector("video").currentTime);
  await p.evaluate(id => window.__watchSelectAudio(Number(id)), process.env.AUDIO);
  await p.waitForTimeout(6000);
  const w2 = await p.evaluate(() => ({ sel: window.__watch().selectedAudio, t: document.querySelector("video").currentTime, buffered: window.__watch().buffered }));
  console.log("after audio switch:", JSON.stringify(w2), "was t", before.toFixed(1));
}
if (process.env.SUB) {
  await p.evaluate(n => window.__watchSelectSub(Number(n) || null), process.env.SUB);
  await p.waitForTimeout(3000);
  await p.evaluate(() => { const v = document.querySelector("video"); if (v.paused) window.__session()?.ass.renderNow(); });
  await p.waitForTimeout(500);
  await p.screenshot({ path: "/tmp/pw-sub.png" });
  const w3 = await p.evaluate(() => ({ sel: window.__watch().subs.selected, active: window.__watch().subs.activeAss, jassub: window.__watch().subs.jassub }));
  console.log("after sub switch:", JSON.stringify(w3), "screenshot /tmp/pw-sub.png");
}
await b.close();
