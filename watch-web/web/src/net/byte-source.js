// Range-fetching byte source for one remote file, with a chunk cache and a tee.
//
// mediabunny drives reads through `read(start, end)`. We serve them from
// CHUNK-aligned Range requests so a demuxer asking for many small blocks turns into
// few large HTTP requests. Every byte that comes back is also handed, in file order,
// to an optional tee (the subtitle parser), so the subtitle track never needs a
// second download of the file.
const CHUNK = 4 * 1024 * 1024;         // bytes per Range request
const MAX_CACHED_CHUNKS = 24;          // ~96 MiB
const PREFETCH_AHEAD = 2;              // chunks to keep in flight past the read cursor

export class ByteSource {
  constructor(url, { chunkSize = CHUNK, fetchImpl = (...a) => globalThis.fetch(...a), size = null } = {}) {
    this.url = url;
    this.chunkSize = chunkSize;
    this.fetchImpl = fetchImpl;
    this.size = size > 0 ? size : null;   // hint from the relay, if it had one
    this.chunks = new Map();     // chunkIndex -> Promise<Uint8Array>
    this.order = [];             // LRU of chunk indices
    this.tee = null;             // { cursor, write(offset, bytes) }
    this.bytesFetched = 0;
    this.requests = 0;
  }

  // The CDN's CORS policy doesn't expose Content-Range, but Content-Length is a
  // CORS-safelisted header, so we read the size from a HEAD (or an aborted GET).
  async getSize() {
    if (this.size != null) return this.size;
    const tryHead = async () => {
      const res = await this.fetchImpl(this.url, { method: "HEAD" }); this.requests++;
      const n = Number(res.headers.get("content-length")); return res.ok && n > 0 ? n : null;
    };
    const tryGet = async () => {
      const res = await this.fetchImpl(this.url); this.requests++;
      const n = Number(res.headers.get("content-length"));
      try { await res.body?.cancel(); } catch {}
      return res.ok && n > 0 ? n : null;
    };
    const cr = async () => {   // last resort: Content-Range, if the CDN does expose it
      const res = await this.fetchImpl(this.url, { headers: { Range: "bytes=0-0" } }); this.requests++;
      const m = /\/(\d+)$/.exec(res.headers.get("content-range") || ""); await res.arrayBuffer().catch(() => {});
      return m ? Number(m[1]) : null;
    };
    for (const f of [tryHead, tryGet, cr]) { try { const n = await f(); if (n) { this.size = n; return n; } } catch {} }
    throw new Error("Could not determine file size from the CDN");
  }

  _fetchChunk(index) {
    if (this.chunks.has(index)) return this.chunks.get(index);
    const start = index * this.chunkSize;
    const end = Math.min(start + this.chunkSize, this.size) - 1;
    const p = (async () => {
      const res = await this.fetchImpl(this.url, { headers: { Range: `bytes=${start}-${end}` } });
      this.requests++;
      if (!(res.status === 206 || res.status === 200)) throw new Error(`Range fetch failed: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      this.bytesFetched += bytes.byteLength;
      this._teeMaybe(start, bytes);
      return bytes;
    })();
    this.chunks.set(index, p);
    this.order.push(index);
    while (this.order.length > MAX_CACHED_CHUNKS) this.chunks.delete(this.order.shift());
    p.catch(() => { this.chunks.delete(index); });
    return p;
  }

  // Sequential reads (the playback region) get prefetched a couple of chunks ahead.
  async read(start, end) {
    if (this.size == null) await this.getSize();
    const first = Math.floor(start / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    const pending = [];
    for (let i = first; i <= last; i++) pending.push(this._fetchChunk(i));           // needed chunks start first
    for (let i = last + 1; i <= last + PREFETCH_AHEAD; i++) if (i * this.chunkSize < this.size) this._fetchChunk(i);
    const parts = await Promise.all(pending);
    if (parts.length === 1) {
      const off = start - first * this.chunkSize;
      return parts[0].subarray(off, off + (end - start));
    }
    const out = new Uint8Array(end - start);
    let pos = 0;
    for (let i = first; i <= last; i++) {
      const chunkStart = i * this.chunkSize;
      const from = Math.max(start, chunkStart) - chunkStart;
      const to = Math.min(end, chunkStart + this.chunkSize) - chunkStart;
      out.set(parts[i - first].subarray(from, to), pos);
      pos += to - from;
    }
    return out;
  }

  // Tee: every fetched chunk is handed to the tee with its file offset. The tee (the
  // subtitle demuxer) decides what is header, what continues its cursor, and when
  // to resync after a jump.
  setTee(tee) { this.tee = tee; }
  _teeMaybe(start, bytes) { try { this.tee?.write(start, bytes); } catch {} }

  // Explicitly pull a region (used to walk the header for tracks + fonts).
  async prefetch(start, end) { await this.read(start, Math.min(end, this.size ?? end)); }

  dispose() { this.chunks.clear(); this.order.length = 0; this.tee = null; }
}
