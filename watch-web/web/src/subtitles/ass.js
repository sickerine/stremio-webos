// Styled ASS/SSA rendering with jassub (libass in WASM), fed live from the Matroska
// byte stream via matroska-subtitles. Fonts come from the file's attachments.
// jassub's worker has bare imports (abslink, lfa-ponyfill), so it must be bundled:
// `?worker&url` makes Vite build it as a module worker and hand back its URL.
import JASSUB from "jassub";
import jassubWorkerUrlGl from "jassub/dist/worker/worker.js?worker&url";
import jassubWorkerUrl2d from "./jassub-worker-2d.js?worker&url";
import jassubWorkerUrlDiag from "./jassub-worker-diag.js?worker&url";
const params = new URLSearchParams(location.search);
const jassubWorkerUrl = params.has("ass2d") ? jassubWorkerUrl2d : params.has("assdebug") ? jassubWorkerUrlDiag : jassubWorkerUrlGl;
if (params.has("assdebug") && typeof window !== "undefined") {
  window.__jlog = [];
  new BroadcastChannel("jassub-log").onmessage = e => { window.__jlog.push(e.data); if (window.__jlog.length > 400) window.__jlog.shift(); };
}
import jassubWasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import jassubModernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";
import jassubFallbackFontUrl from "jassub/dist/default.woff2?url";

// matroska-subtitles ships a classic UMD bundle (sets window.MatroskaSubtitles); it is
// loaded by a plain <script> in index.html and read lazily here.
const MS = () => { const m = window.MatroskaSubtitles; if (!m) throw new Error("matroska-subtitles not loaded"); return m; };
const PARK_WINDOW = 16 * 1024 * 1024;   // <= ByteSource prefetch depth; beyond this a gap is a seek
const ASS_DEBUG = new URLSearchParams(location.search).has("assdebug");
if (typeof window !== "undefined") window.__JASSUB = JASSUB;   // for in-browser diagnostics

function findClusterId(bytes, from = 0) {
  for (let i = from; i < bytes.length - 4; i++) {
    if (bytes[i] === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) return i;
  }
  return -1;
}

// Reconstruct the Matroska ASS block payload libass expects in ass_process_chunk:
// "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
// libass drops any chunk whose ReadOrder it has already seen, and matroska-subtitles
// does not surface the real ReadOrder, so we number events ourselves per track.
function blockPayload(s, readOrder) {
  return [readOrder, s.layer ?? 0, s.style ?? "Default", s.name ?? "", s.marginL ?? 0, s.marginR ?? 0, s.marginV ?? 0, s.effect ?? "", s.text ?? ""].join(",");
}

/**
 * SubtitleDemux receives every chunk the ByteSource fetches (offset + bytes).
 *  - Bytes before the first Cluster are the header: parsed from offset 0 for
 *    track list + font attachments.
 *  - Bytes after it feed a SubtitleStream that follows a cursor; a forward jump
 *    (playback start, TV seek) opens a fresh SubtitleStream that resyncs on the
 *    next Cluster boundary.
 * Emits: onTracks(tracks), onFont(file), onCue(trackNumber, cue)
 */
export class SubtitleDemux {
  // `tap(tag)` sees every decoded EBML tag (used for bitmap subtitle tracks, which
  // matroska-subtitles itself ignores).
  constructor({ onTracks, onFont, onCue, tap }) {
    this.onTracks = onTracks; this.onFont = onFont; this.onCue = onCue; this.tap = tap;
    this.tracks = null;
    this.firstCluster = null;     // byte offset of the first Cluster (header end)
    this.headerCursor = 0;
    this.headerParser = new (MS().SubtitleParser)();
    // SubtitleParser ends itself when the file has no S_TEXT tracks; a placeholder keeps
    // it decoding so the tap still gets blocks. Filtered out of the emitted list below.
    this.headerParser.subtitleTracks.set(-1, { number: -1 });
    if (tap) this.headerParser.decoder.on("data", tap);
    this.headerParser.once("tracks", t => { t = t.filter(x => x.number !== -1); this.tracks = t; queueMicrotask(() => { try { onTracks?.(t); } catch (e) { this.stats.lastConsumerError = `${e?.message || e}`; } }); });
    this.headerParser.on("file", f => queueMicrotask(() => { try { onFont?.(f); } catch (e) { this.stats.lastConsumerError = `${e?.message || e}`; } }));
    this.headerParser.on("subtitle", (s, n) => this._emitCue(n, s));
    this.headerParser.on("error", () => {});
    this.headerParser.resume?.();
    this.stream = null;
    this.cursor = null;
    this.pending = new Map();     // offset -> bytes that arrived ahead of the cursor
    this.stats = { headerBytes: 0, streamBytes: 0, streamsOpened: 0, parked: 0, dropped: 0, cues: 0, writeErrors: 0, decodeErrors: 0, lastError: null };
    this._instrument(this.headerParser);
  }

  // matroska-subtitles swallows EBML decode errors with a bare console.warn; keep the
  // real message so failures are diagnosable from the debug handle.
  _instrument(p) {
    const dec = p.decoder; if (!dec || dec.__watchWrapped) return;
    const orig = dec.write.bind(dec);
    dec.write = chunk => { try { return orig(chunk); } catch (e) { this.stats.decodeErrors++; this.stats.lastError = `decode: ${e?.message || e}`; throw e; } };
    dec.__watchWrapped = true;
  }
  _write(p, bytes, counter) {
    try { p.write(bytes); this.stats[counter] += bytes.byteLength; }
    catch (e) { this.stats.writeErrors++; this.stats.lastWriteError = `${e?.message || e}`; }
  }
  // Consumer callbacks run outside the parser's call stack so a renderer hiccup can
  // never be mistaken for (or cause) an EBML decode error.
  _emitCue(n, s) { queueMicrotask(() => { try { this.onCue?.(n, s); } catch (e) { this.stats.consumerErrors = (this.stats.consumerErrors || 0) + 1; this.stats.lastConsumerError = `${e?.message || e}`; } }); }

  get headerDone() { return this.firstCluster != null && this.headerCursor >= this.firstCluster; }

  // Chunks are fetched concurrently, so they can arrive out of order. Anything within
  // one prefetch window ahead of the cursor is parked until the gap fills; anything
  // farther is a real jump (playback start / TV seek) and resyncs the stream there.
  write(offset, bytes) {
    this._accept(offset, bytes);
    // drain parked chunks that now continue the cursor
    for (;;) {
      const cur = this.headerDone ? this.cursor : this.headerCursor;
      const next = this.pending.get(cur);
      if (!next) break;
      this.pending.delete(cur);
      this._accept(cur, next);
    }
  }

  _accept(offset, bytes) {
    const end = offset + bytes.byteLength;
    if (!this.headerDone) {
      if (offset > this.headerCursor) { if (offset - this.headerCursor <= PARK_WINDOW) { this.pending.set(offset, bytes); this.stats.parked++; } else this.stats.dropped++; return; }
      if (end <= this.headerCursor) return;
      const slice = bytes.subarray(this.headerCursor - offset);
      if (this.firstCluster == null) { const idx = findClusterId(slice); if (idx >= 0) this.firstCluster = this.headerCursor + idx; }
      this._write(this.headerParser, slice, "headerBytes");
      this.headerCursor = end;
      if (this.headerDone) this._openStream(this.headerCursor);
      return;
    }
    if (this.firstCluster != null && end <= this.firstCluster) return; // header re-read
    const cur = this.cursor;
    if (cur == null || offset > cur + PARK_WINDOW || offset < cur - PARK_WINDOW) {
      // far jump in either direction (Cues read at the tail, playback start, TV seek)
      this.pending.clear();
      this._openStream(offset);
    } else if (offset > cur) { this.pending.set(offset, bytes); this.stats.parked++; return; }   // small gap: wait for it
    else if (offset < cur) { if (end <= cur) return; bytes = bytes.subarray(cur - offset); offset = cur; } // overlap
    this._write(this.stream, bytes, "streamBytes");
    this.cursor = offset + bytes.byteLength;
  }

  _openStream(offset) {
    try { this.stream?.destroy(); } catch {}
    this.stats.streamsOpened++;
    this.stream = new (MS().SubtitleStream)(this.stream || this.headerParser);
    this._instrument(this.stream);
    if (this.tap) this.stream.decoder.on("data", this.tap);
    this.stream.on("subtitle", (s, n) => { this.stats.cues++; this._emitCue(n, s); });
    this.stream.on("error", () => {});
    this.stream.resume?.();
    this.cursor = offset;
  }

  dispose() { try { this.headerParser.destroy(); this.stream?.destroy(); } catch {} }
}

/** AssRenderer: one jassub instance bound to the video; switch tracks instantly. */
export class AssRenderer {
  // `layer` is a slotted, full-bleed div inside media-controller. Each jassub instance
  // gets a fresh <canvas> in it: jassub transfers the canvas to its worker, and a
  // transferred canvas can never be reused, so track switches need a new element.
  constructor(video, layer) {
    this.video = video;
    this.layer = layer;
    this.canvas = null;
    this.showCalls = 0;
    this.lastError = null;
    this.fonts = [];
    this.jassub = null;
    this.ready = false;           // jassub worker up; until then cues are only stored
    this.activeTrack = null;
    this.headers = new Map();     // trackNumber -> header string
    this.events = new Map();      // trackNumber -> [{payload,time,duration}]
    this.seen = new Map();        // trackNumber -> Set(readOrder) to dedupe after resync
  }
  setTracks(tracks) { for (const t of tracks) if (t.type === "ass" || t.type === "ssa") this.headers.set(t.number, t.header || ""); }
  addFont(file) {
    if (!/font|ttf|otf|woff/i.test(file.mimetype || "") && !/\.(ttf|otf|ttc|woff2?)$/i.test(file.filename || "")) return;
    const bytes = new Uint8Array(file.data);
    this.fonts.push(bytes);
    if (this.ready && this.jassub?.renderer) this.jassub.renderer.addFonts([bytes]).catch(() => {});
  }
  addCue(trackNumber, s) {
    if (!this.headers.has(trackNumber)) return;
    // Identity = start + layer + style + text. Duration is deliberately excluded (a resync
    // re-emit could differ there and slip through); layer/style are included so a typeset
    // pair with identical text on two layers is not collapsed.
    const key = `${s.time}:${s.layer ?? 0}:${s.style ?? ""}:${s.text}`;
    let seen = this.seen.get(trackNumber); if (!seen) this.seen.set(trackNumber, seen = new Set());
    if (seen.has(key)) { this.dupes = (this.dupes || 0) + 1; return; } seen.add(key);
    let list = this.events.get(trackNumber); if (!list) this.events.set(trackNumber, list = []);
    const ev = { payload: blockPayload(s, list.length + 1), time: s.time, duration: s.duration ?? 0 };
    list.push(ev);
    if (trackNumber === this.activeTrack && this.ready && this.jassub?.renderer) { this.pushed++; this.jassub.renderer.processChunk(ev.payload, ev.time, ev.duration); if (this.video.paused) this.renderNow(); }
  }
  async show(trackNumber) {
    if (trackNumber === this.activeTrack && this.jassub) return;
    await this.hide();
    const header = this.headers.get(trackNumber);
    if (header == null) return;
    this.activeTrack = trackNumber;
    this.showCalls++;
    const canvas = document.createElement("canvas");
    this.layer.replaceChildren(canvas);
    this.canvas = canvas;
    let j;
    try {
      j = new JASSUB({
        video: this.video, canvas, subContent: header,
        workerUrl: jassubWorkerUrl, wasmUrl: jassubWasmUrl, modernWasmUrl: jassubModernWasmUrl,
        availableFonts: { "liberation sans": jassubFallbackFontUrl }, defaultFont: "liberation sans", fonts: this.fonts,
        prescaleFactor: 0.8, prescaleHeightLimit: 1080, maxRenderHeight: 2160, debug: ASS_DEBUG,
      });
    } catch (e) { this.lastError = `jassub ctor: ${e?.message || e}`; return; }
    this.jassub = j; this.ready = false; this.pushed = 0;
    try { await j.ready; } catch (e) { this.lastError = `jassub: ${e?.message || e}`; }
    if (this.jassub !== j) return;
    this.ready = Boolean(j.renderer);
    // The renderer may have been created before the <video> had dimensions (MSE
    // attaches later); size it now and again whenever the video's geometry changes.
    const fit = () => { if (this.jassub === j && this.video.videoWidth) j.resize(true).catch(() => {}); };
    fit();
    this._fit = fit;
    for (const ev of ["loadedmetadata", "resize", "playing"]) this.video.addEventListener(ev, fit);
    // replay everything collected so far (including cues that arrived while the worker booted)
    if (this.ready) { for (const ev of this.events.get(trackNumber) || []) { this.pushed++; j.renderer.processChunk(ev.payload, ev.time, ev.duration); } this.renderNow(); }
  }
  // While the video is paused, requestVideoFrameCallback never fires (notably in
  // Firefox), so jassub would not repaint after a seek/pause. Force one render at the
  // current time. Safe to call when playing too.
  renderNow() {
    const j = this.jassub;
    if (!this.ready || !j?.renderer || !this.video.videoWidth) return;
    j.manualRender({ mediaTime: this.video.currentTime, expectedDisplayTime: performance.now(), width: this.video.videoWidth, height: this.video.videoHeight }, true).catch(() => {});
  }
  async hide() {
    this.activeTrack = null; this.ready = false;
    if (this._fit) { for (const ev of ["loadedmetadata", "resize", "playing"]) this.video.removeEventListener(ev, this._fit); this._fit = null; }
    if (this.jassub) { const j = this.jassub; this.jassub = null; await j.destroy().catch(() => {}); }
    this.canvas?.remove(); this.canvas = null;
  }
}
