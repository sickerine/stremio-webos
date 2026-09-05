// Offline check of the bitmap-subtitle chain: Matroska header + a mid-file slice ->
// matroska-subtitles decoder tap -> BitmapDemux -> .mks/.sup -> libbitsub WASM -> frames.
// Usage: node scripts/bitmap-probe.mjs /tmp/hulk-head.bin /tmp/hulk-mid.bin
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { BitmapDemux, buildMks, buildSup } from "../web/src/subtitles/bitmap-demux.js";
const require = createRequire(import.meta.url);
const { SubtitleParser, SubtitleStream } = require("matroska-subtitles");
const wasm = await import("../node_modules/libbitsub/pkg/libbitsub.js");
await wasm.default(readFileSync(new URL("../node_modules/libbitsub/pkg/libbitsub_bg.wasm", import.meta.url)));

const [head, mid] = process.argv.slice(2).map(f => readFileSync(f));
const blocks = new Map(); let tracks = [];
const demux = new BitmapDemux({ onTracks: t => { tracks = t; }, onBlock: (tr, b) => { let l = blocks.get(tr.number); if (!l) blocks.set(tr.number, l = []); l.push(b); } });
const hp = new SubtitleParser();
hp.subtitleTracks.set(-1, { number: -1 });        // keep it decoding when the file has no S_TEXT tracks
hp.decoder.on("data", demux.tap);
hp.on("error", () => {});
hp.write(head);
for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
console.log("tracks:", tracks.map(t => ({ n: t.number, type: t.type, lang: t.language, name: t.name, comp: t.compression, priv: t.codecPrivate.length })));
console.log("idx head:", JSON.stringify(new TextDecoder().decode(tracks[0]?.codecPrivate.subarray(0, 160))));
const st = new SubtitleStream(hp);
st.decoder.on("data", demux.tap); st.on("error", () => {});
for (let o = 0; o < mid.length; o += 4 << 20) st.write(mid.subarray(o, o + (4 << 20)));
await new Promise(r => setTimeout(r, 300));
console.log("demux stats:", demux.stats, "blocks per track:", [...blocks].map(([n, l]) => [n, l.length]));
for (const t of tracks) {
  const list = (blocks.get(t.number) || []).sort((a, b) => a.time - b.time);
  if (!list.length) continue;
  console.log(`\n== track ${t.number} ${t.type} ${t.language} first=${(list[0].time / 1000).toFixed(1)}s last=${(list.at(-1).time / 1000).toFixed(1)}s sizes=${list.slice(0, 5).map(b => b.data.length)}`);
  let p;
  try {
    if (t.type === "vobsub") { p = new wasm.VobSubParser(); p.loadFromMks(buildMks(t, list)); }
    else { p = new wasm.PgsParser(); p.parse(buildSup(list)); }
  } catch (e) { console.log("LOAD FAILED:", e?.message || e); continue; }
  const ts = p.getTimestamps();
  console.log("cues:", ts.length, "screen:", p.screenWidth, "x", p.screenHeight, "first ts:", [...ts.slice(0, 4)]);
  for (const i of [0, Math.floor(ts.length / 2)]) {
    if (i >= ts.length) break;
    const start = p.getCueStartTime(i), end = p.getCueEndTime(i);
    const f = p.renderAtIndex(i);
    const one = c => c && { x: c.x, y: c.y, w: c.width, h: c.height, rgba: c.getRgba().length, opaque: c.getRgba().filter((v, j) => j % 4 === 3 && v > 0).length };
    const comps = !f ? null : f.compositionCount != null ? Array.from({ length: f.compositionCount }, (_, k) => one(f.getComposition(k))) : [one(f)];
    console.log(`cue ${i}: start=${start} end=${end} idxAt(start+100ms)=${p.findIndexAtTimestamp(start + 100)} idxAt(end+100ms)=${p.findIndexAtTimestamp(end + 100)} idxAt(end-100ms)=${p.findIndexAtTimestamp(end - 100)} comps=${JSON.stringify(comps)}`);
  }
  console.log("lastRenderIssue:", p.lastRenderIssue);
}
