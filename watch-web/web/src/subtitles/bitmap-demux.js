// Bitmap subtitle tracks (S_HDMV/PGS, S_VOBSUB) taken from the Matroska tag stream that
// matroska-subtitles already decodes (it drops everything that is not S_TEXT). Pure
// helpers here (no DOM) so they can be exercised under node; rendering lives in bitmap.js.
const ID = {
  TimecodeScale: 0x2ad7b1, Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86,
  CodecPrivate: 0x63a2, Language: 0x22b59c, Name: 0x536e, ContentEncodings: 0x6d80, ContentEncoding: 0x6240,
  ContentCompression: 0x5034, ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255,
  Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b,
};
const CODECS = { "S_HDMV/PGS": "pgs", "S_VOBSUB": "vobsub" };
const child = (m, id) => m?.Children?.find(c => c.id === id);
const data = (m, id) => child(m, id)?.data;
const bytes = b => (b ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice() : new Uint8Array(0));

/**
 * BitmapDemux.tap is attached to each ebml-stream decoder the SubtitleDemux drives.
 * Emits onTracks([{number,type,language,name,codecPrivate}]) once, and
 * onBlock(track, {time(ms), duration(ms), data}) per subtitle block (decompressed).
 */
export class BitmapDemux {
  constructor({ onTracks, onBlock }) {
    this.onTracks = onTracks; this.onBlock = onBlock;
    this.tracks = new Map(); this.scale = 1; this.cluster = 0;
    this.stats = { blocks: 0, skipped: 0 };
    this.tap = t => { try { this._tag(t); } catch (e) { this.stats.lastError = `${e?.message || e}`; } };
  }
  _tag(t) {
    if (t.id === ID.TimecodeScale) this.scale = t.data / 1e6;
    else if (t.id === ID.Timecode) this.cluster = t.data;
    else if (t.id === ID.Tracks) this._tracks(t);
    else if (t.id === ID.SimpleBlock) this._block(t, 0);
    else if (t.id === ID.BlockGroup) { const b = child(t, ID.Block); if (b) this._block(b, data(t, ID.BlockDuration) || 0); }
  }
  _tracks(tracks) {
    if (this.tracks.size) return;                       // header re-read after a jump to 0
    for (const e of tracks.Children) {
      if (e.id !== ID.TrackEntry || data(e, ID.TrackType) !== 0x11) continue;
      const type = CODECS[data(e, ID.CodecID) || ""]; if (!type) continue;
      const comp = child(child(child(e, ID.ContentEncodings), ID.ContentEncoding), ID.ContentCompression);
      const number = data(e, ID.TrackNumber);
      this.tracks.set(number, {
        number, type, language: data(e, ID.Language), name: data(e, ID.Name), codecPrivate: bytes(data(e, ID.CodecPrivate)),
        compression: comp ? (data(comp, ID.ContentCompAlgo) ?? 0) : null, settings: bytes(data(comp, ID.ContentCompSettings)),
      });
    }
    if (this.tracks.size) this.onTracks([...this.tracks.values()]);
  }
  _block(b, duration) {
    const tr = this.tracks.get(b.track); if (!tr) return;
    if (b.lacing) { this.stats.skipped++; return; }
    const cue = { time: (this.cluster + b.value) * this.scale, duration: duration * this.scale };
    const out = inflate(tr, bytes(b.payload));
    if (!out) { this.stats.skipped++; return; }
    this.stats.blocks++;
    if (out instanceof Promise) out.then(d => this.onBlock(tr, { ...cue, data: d }), e => { this.stats.lastError = `inflate: ${e?.message || e}`; });
    else this.onBlock(tr, { ...cue, data: out });
  }
}

// ContentCompAlgo: 0 zlib, 3 header stripping. (1 bzip2 / 2 lzo are not seen in the wild.)
function inflate(tr, d) {
  if (tr.compression == null) return d;
  if (tr.compression === 3) { const out = new Uint8Array(tr.settings.length + d.length); out.set(tr.settings); out.set(d, tr.settings.length); return out; }
  if (tr.compression === 0) return new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer().then(b => new Uint8Array(b));
  return null;
}

// ---- container builders: libbitsub wants a .sup (PGS) or an .mks (VobSub) ----
const enc = new TextEncoder();
export function cat(parts) { let n = 0; for (const p of parts) n += p.length; const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
function be(n, len) { const out = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { out[i] = n % 256; n = Math.floor(n / 256); } return out; }
export function vint(n) { let len = 1; while (len < 8 && n >= 2 ** (7 * len) - 1) len++; const out = be(n, len); out[0] |= 0x80 >> (len - 1); return out; }
function uint(n) { let len = 1; while (len < 8 && n >= 2 ** (8 * len)) len++; return be(n, len); }
function id(n) { return uint(n); }
export function el(tag, ...payload) { const body = cat(payload); return cat([id(tag), vint(body.length), body]); }

/** PGS blocks in Matroska are bare segments; a .sup wraps each in "PG"+PTS+DTS. */
export function buildSup(blocks) {
  const parts = [];
  for (const b of blocks) {
    const pts = Math.round(b.time * 90), d = b.data;
    for (let i = 0; i + 3 <= d.length;) {
      const size = (d[i + 1] << 8) | d[i + 2];
      parts.push(cat([enc.encode("PG"), be(pts, 4), be(0, 4)]), d.subarray(i, i + 3 + size));
      i += 3 + size;
    }
  }
  return cat(parts);
}

/** Minimal .mks: one VobSub track (CodecPrivate = .idx text), one cluster per block. */
export function buildMks(track, blocks) {
  const header = el(0x1a45dfa3, el(0x4286, uint(1)), el(0x42f7, uint(1)), el(0x42f2, uint(4)), el(0x42f3, uint(8)), el(0x4282, enc.encode("matroska")), el(0x4287, uint(4)), el(0x4285, uint(2)));
  const info = el(0x1549a966, el(0x2ad7b1, uint(1000000)));
  const entry = el(0xae, el(0xd7, uint(1)), el(0x73c5, uint(1)), el(0x83, uint(0x11)), el(0x86, enc.encode("S_VOBSUB")), el(0x63a2, track.codecPrivate), el(0x22b59c, enc.encode(track.language || "und")));
  const clusters = blocks.map(b => el(0x1f43b675, el(0xe7, uint(Math.round(b.time))), el(0xa0, el(0xa1, Uint8Array.of(0x81, 0, 0, 0), b.data), el(0x9b, uint(Math.round(b.duration || 0))))));
  return cat([header, el(0x18538067, info, el(0x1654ae6b, entry), ...clusters)]);
}
