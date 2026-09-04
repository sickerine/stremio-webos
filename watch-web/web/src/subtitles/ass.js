// Styled ASS/SSA rendering with jassub (libass in WASM), fed live from the Matroska
// byte stream via matroska-subtitles. Fonts come from the file's attachments.
// jassub's dist is copied verbatim to /jassub (see package.json "assets") because its
// worker imports sibling modules relatively.
import JASSUB from "jassub";

// matroska-subtitles ships a classic UMD bundle (sets window.MatroskaSubtitles); it is
// loaded by a plain <script> in index.html and read lazily here.
const MS = () => { const m = window.MatroskaSubtitles; if (!m) throw new Error("matroska-subtitles not loaded"); return m; };
const PARK_WINDOW = 16 * 1024 * 1024;   // <= ByteSource prefetch depth; beyond this a gap is a seek

function findClusterId(bytes, from = 0) {
  for (let i = from; i < bytes.length - 4; i++) {
    if (bytes[i] === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) return i;
  }
  return -1;
}

// Reconstruct the Matroska ASS block payload libass expects in ass_process_chunk:
// "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
function blockPayload(s) {
  return [s.readOrder ?? 0, s.layer ?? 0, s.style ?? "Default", s.name ?? "", s.marginL ?? 0, s.marginR ?? 0, s.marginV ?? 0, s.effect ?? "", s.text ?? ""].join(",");
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
  constructor({ onTracks, onFont, onCue }) {
    this.onTracks = onTracks; this.onFont = onFont; this.onCue = onCue;
    this.tracks = null;
    this.firstCluster = null;     // byte offset of the first Cluster (header end)
    this.headerCursor = 0;
    this.headerParser = new (MS().SubtitleParser)();
    this.headerParser.once("tracks", t => { this.tracks = t; onTracks?.(t); });
    this.headerParser.on("file", f => onFont?.(f));
    this.headerParser.on("subtitle", (s, n) => onCue?.(n, s));
    this.headerParser.on("error", () => {});
    this.headerParser.resume?.();
    this.stream = null;
    this.cursor = null;
    this.pending = new Map();     // offset -> bytes that arrived ahead of the cursor
  }

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
      if (offset > this.headerCursor) { if (offset - this.headerCursor <= PARK_WINDOW) this.pending.set(offset, bytes); return; }
      if (end <= this.headerCursor) return;
      const slice = bytes.subarray(this.headerCursor - offset);
      if (this.firstCluster == null) { const idx = findClusterId(slice); if (idx >= 0) this.firstCluster = this.headerCursor + idx; }
      try { this.headerParser.write(slice); } catch {}
      this.headerCursor = end;
      if (this.headerDone) this._openStream(this.headerCursor);
      return;
    }
    if (this.firstCluster != null && end <= this.firstCluster) return; // header re-read
    if (this.cursor == null || offset > this.cursor) {
      if (this.cursor != null && offset - this.cursor <= PARK_WINDOW) { this.pending.set(offset, bytes); return; }
      this.pending.clear();
      this._openStream(offset);
    }
    if (offset < this.cursor) { if (end <= this.cursor) return; bytes = bytes.subarray(this.cursor - offset); offset = this.cursor; }
    try { this.stream.write(bytes); } catch {}
    this.cursor = end;
  }

  _openStream(offset) {
    try { this.stream?.destroy(); } catch {}
    this.stream = new (MS().SubtitleStream)(this.stream || this.headerParser);
    this.stream.on("subtitle", (s, n) => this.onCue?.(n, s));
    this.stream.on("error", () => {});
    this.stream.resume?.();
    this.cursor = offset;
  }

  dispose() { try { this.headerParser.destroy(); this.stream?.destroy(); } catch {} }
}

/** AssRenderer: one jassub instance bound to the video; switch tracks instantly. */
export class AssRenderer {
  constructor(video) {
    this.video = video;
    this.fonts = [];
    this.jassub = null;
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
    if (this.jassub) this.jassub.renderer.addFonts([bytes]).catch(() => {});
  }
  addCue(trackNumber, s) {
    if (!this.headers.has(trackNumber)) return;
    const key = `${s.readOrder ?? s.time}:${s.time}`;
    let seen = this.seen.get(trackNumber); if (!seen) this.seen.set(trackNumber, seen = new Set());
    if (seen.has(key)) return; seen.add(key);
    const ev = { payload: blockPayload(s), time: s.time, duration: s.duration ?? 0 };
    let list = this.events.get(trackNumber); if (!list) this.events.set(trackNumber, list = []);
    list.push(ev);
    if (trackNumber === this.activeTrack && this.jassub) this.jassub.renderer.processChunk(ev.payload, ev.time, ev.duration);
  }
  async show(trackNumber) {
    if (trackNumber === this.activeTrack && this.jassub) return;
    await this.hide();
    const header = this.headers.get(trackNumber);
    if (header == null) return;
    this.activeTrack = trackNumber;
    const j = new JASSUB({
      video: this.video, subContent: header,
      workerUrl: "/jassub/worker/worker.js", wasmUrl: "/jassub/wasm/jassub-worker.wasm", modernWasmUrl: "/jassub/wasm/jassub-worker-modern.wasm",
      fallbackFont: "/jassub/default.woff2", fonts: this.fonts,
      prescaleFactor: 0.8, prescaleHeightLimit: 1080, maxRenderHeight: 2160, libassMemoryLimit: 60, libassGlyphLimit: 60,
    });
    this.jassub = j;
    await j.ready.catch(() => {});
    if (this.jassub !== j) return;
    for (const ev of this.events.get(trackNumber) || []) j.renderer.processChunk(ev.payload, ev.time, ev.duration);
  }
  async hide() {
    this.activeTrack = null;
    if (this.jassub) { const j = this.jassub; this.jassub = null; await j.destroy().catch(() => {}); }
  }
}
