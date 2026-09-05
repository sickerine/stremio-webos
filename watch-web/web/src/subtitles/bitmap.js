// Bitmap subtitles (PGS / VobSub) drawn on our own canvas over the video. libbitsub's
// WASM parsers do the decoding; it has no live API for VobSub, so the selected track is
// re-loaded from all blocks seen so far whenever new ones arrive (debounced).
import { initWasm, PgsParser, VobSubParserLowLevel } from "libbitsub";
import { buildMks, buildSup } from "./bitmap-demux.js";

export class BitmapRenderer {
  constructor(video, layer) {
    this.video = video; this.layer = layer;
    this.tracks = new Map();      // number -> track (from BitmapDemux)
    this.blocks = new Map();      // number -> Map(time -> block)
    this.active = null; this.parser = null; this.canvas = null; this.drawn = -2;
    this.stats = { rebuilds: 0, cues: 0, blocks: 0, dupes: 0, error: null };
  }
  setTracks(tracks) { for (const t of tracks) this.tracks.set(t.number, t); }
  addBlock(track, b) {
    let list = this.blocks.get(track.number); if (!list) this.blocks.set(track.number, list = new Map());
    if (list.has(b.time)) { this.stats.dupes++; return; }          // stream resync re-emits blocks
    list.set(b.time, b); this.stats.blocks++;
    if (track.number === this.active) this._schedule();
  }
  _schedule() { if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; this._rebuild(); }, 400); }
  // ponytail: whole-track reload per batch (O(n) each); switch to PgsParser.feed / incremental
  // MKS if a track ever reaches tens of thousands of cues.
  async _rebuild() {
    const t = this.tracks.get(this.active); if (!t) return;
    const blocks = [...(this.blocks.get(t.number)?.values() || [])].sort((a, b) => a.time - b.time);
    if (!blocks.length) return;
    try {
      await initWasm();
      if (this.active !== t.number) return;
      if (!this.parser) this.parser = t.type === "pgs" ? new PgsParser() : new VobSubParserLowLevel();
      if (t.type === "pgs") this.parser.load(buildSup(blocks)); else this.parser.loadFromMks(buildMks(t, blocks));
      this.stats.rebuilds++; this.stats.cues = this.parser.count; this.stats.error = null;
      this.drawn = -2; this.renderNow();
    } catch (e) { this.stats.error = `${e?.message || e}`; }
  }
  async show(number) {
    if (number === this.active) return;
    this.hide();
    if (!this.tracks.has(number)) return;
    this.active = number;
    const c = document.createElement("canvas");
    this.layer.replaceChildren(c); this.canvas = c;
    this.ro = new ResizeObserver(() => this._fit()); this.ro.observe(this.layer);
    const loop = () => { this._tick(); this.raf = requestAnimationFrame(loop); }; this.raf = requestAnimationFrame(loop);
    await this._rebuild();
  }
  hide() {
    this.active = null; this.drawn = -2;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    cancelAnimationFrame(this.raf); this.ro?.disconnect(); this.ro = null;
    this.canvas?.remove(); this.canvas = null;
    try { this.parser?.dispose(); } catch {} this.parser = null;
  }
  renderNow() { this._fit(); this._tick(); }
  // The canvas keeps the subtitle screen's pixel size and is CSS-stretched onto the
  // video's rendered rect (object-fit: contain), as players do for DVD/BD subs.
  _fit() {
    const c = this.canvas, v = this.video; if (!c || !v.videoWidth) return;
    const W = this.layer.clientWidth, H = this.layer.clientHeight, s = Math.min(W / v.videoWidth, H / v.videoHeight);
    const w = v.videoWidth * s, h = v.videoHeight * s;
    Object.assign(c.style, { left: `${(W - w) / 2}px`, top: `${(H - h) / 2}px`, width: `${w}px`, height: `${h}px` });
  }
  _tick() {
    const idx = this.parser ? this.parser.findIndexAtTimestamp(this.video.currentTime) : -1;   // -1 past the cue's end
    if (idx !== this.drawn) this._draw(idx);
  }
  _draw(idx) {
    const c = this.canvas; if (!c) return;
    this.drawn = idx;
    const frame = idx >= 0 ? this.parser.renderAtIndex(idx) : null;
    const ctx = c.getContext("2d");
    if (!frame) { ctx.clearRect(0, 0, c.width, c.height); return; }
    if (c.width !== frame.width || c.height !== frame.height) { c.width = frame.width; c.height = frame.height; this._fit(); }
    ctx.clearRect(0, 0, c.width, c.height);
    for (const comp of frame.compositionData) ctx.putImageData(comp.pixelData, comp.x, comp.y);
  }
}
