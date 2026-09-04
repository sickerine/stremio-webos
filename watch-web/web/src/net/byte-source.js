// Range-fetching byte source for one remote file, with a chunk cache and a tee.
//
// mediabunny drives reads through `read(start, end)`. The sequential playback path
// is served from ONE long-lived Range request whose body is sliced into CHUNK-sized
// pieces as it streams in, the way a <video> element downloads. That keeps the request
// rate at "one per seek": TorBox's edge nodes firewall an IP that issues a Range
// request every few MiB (a few per second at 4K bitrates) for a couple of hours.
// Random reads (header, cues, a seek) start a new stream at that offset. Every byte
// is also handed, in file order, to an optional tee (the subtitle parser), so the
// subtitle track never needs a second download of the file.
const CHUNK = 4 * 1024 * 1024;         // bytes per cached chunk
const MAX_CACHED_CHUNKS = 24;          // ~96 MiB
const PREFETCH_AHEAD = 2;              // keep streaming this many chunks past the highest one asked for
const FOLLOW_WINDOW = 6;               // a read this far ahead of the stream waits for it instead of re-requesting
const MAX_ATTEMPTS = 8;
const LOG_KEEP = 200;                  // recent requests, for diagnosing CDN bans
const backoff = attempt => new Promise(r => setTimeout(r, Math.min(30000, 600 * 2 ** attempt)));   // ~100s total; don't hammer a host that refuses us

class Deferred {
  constructor() { this.settled = false; this.promise = new Promise((res, rej) => { this._res = res; this._rej = rej; }); }
  resolve(v) { this.settled = true; this._res(v); }
  reject(e) { this.settled = true; this._rej(e); }
}

export class ByteSource {
  constructor(url, { chunkSize = CHUNK, fetchImpl = (...a) => globalThis.fetch(...a), size = null } = {}) {
    this.url = url;
    this.chunkSize = chunkSize;
    this.fetchImpl = fetchImpl;
    this.size = size > 0 ? size : null;   // hint from the relay, if it had one
    this.chunks = new Map();     // chunkIndex -> Promise<Uint8Array> (resolved, or being filled)
    this.order = [];             // LRU of resolved chunk indices
    this.tee = null;             // { write(offset, bytes) }
    this.bytesFetched = 0;
    this.requests = 0;
    this.retries = 0;
    this.stream = null;          // the one open sequential request: { next, wanted, deferreds, abort, wake }
    this.log = [];               // [{t, k: size|stream|one, s: startByte, st: status|error, ms}]
  }
  _log(k, s, st, t0) { this.log.push({ t: Date.now(), k, s, st: String(st).slice(0, 60), ms: Date.now() - t0 }); if (this.log.length > LOG_KEEP) this.log.shift(); }

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
    for (const f of [tryHead, tryGet, cr]) { const t0 = Date.now(); try { const n = await f(); this._log("size", 0, n ? "ok" : "no-size", t0); if (n) { this.size = n; return n; } } catch (e) { this._log("size", 0, e.message, t0); } }
    throw new Error("Could not determine file size from the CDN");
  }

  _fetchChunk(index) {
    const cached = this.chunks.get(index);
    if (cached) { this._want(index); return cached; }
    const s = this.stream;
    if (s && index >= s.next && index <= s.next + FOLLOW_WINDOW) {          // rides the open stream
      for (let i = s.next; i <= index; i++) this._reserve(s, i);
      this._want(index);
      return this.chunks.get(index);
    }
    return this._startStream(index);
  }

  _reserve(s, index) {
    if (this.chunks.has(index)) return s.deferreds.get(index);
    const d = new Deferred();
    s.deferreds.set(index, d);
    this.chunks.set(index, d.promise);
    d.promise.catch(() => { if (this.chunks.get(index) === d.promise) this.chunks.delete(index); });
    return d;
  }
  _want(index) { const s = this.stream; if (s && index > s.wanted) { s.wanted = index; s.wake?.(); } }
  _settled(index) {
    this.order.push(index);
    while (this.order.length > MAX_CACHED_CHUNKS) this.chunks.delete(this.order.shift());
  }

  // A seek: abandon the open stream and start reading from `index`. Chunks someone is
  // still waiting on from the old stream are fetched individually so no read hangs.
  _startStream(index) {
    const old = this.stream;
    if (old) {
      this.stream = null; old.abort.abort(); old.wake?.();
      // One at a time: TorBox bans IPs that pull ranges over several connections at once.
      for (const [i, d] of old.deferreds) if (!d.settled) {
        this._oneQueue = (this._oneQueue || Promise.resolve()).then(() => d.settled ? null : this._fetchOne(i).then(b => { d.resolve(b); this._settled(i); }, e => d.reject(e)));
      }
    }
    const s = { next: index, wanted: index, deferreds: new Map(), abort: new AbortController(), wake: null };
    this.stream = s;
    this._reserve(s, index);
    this._run(s);
    return this.chunks.get(index);
  }

  async _run(s) {
    let attempt = 0, lastError = null;
    const live = () => this.stream === s;
    const pause = async () => { while (live() && s.next > s.wanted + PREFETCH_AHEAD) { await new Promise(r => { s.wake = r; }); s.wake = null; } };
    while (live() && s.next * this.chunkSize < this.size) {
      await pause(); if (!live()) return;
      try {
        const start = s.next * this.chunkSize, t0 = Date.now();
        let res;
        try { res = await this.fetchImpl(this.url, { headers: { Range: `bytes=${start}-` }, signal: s.abort.signal }); }
        catch (e) { this._log("stream", start, e.message, t0); throw e; }
        this.requests++; this._log("stream", start, res.status, t0);
        if (!(res.status === 206 || (res.status === 200 && start === 0))) throw new Error(`Range fetch failed: ${res.status}`);
        const reader = res.body.getReader();
        let buf = new Uint8Array(this.chunkSize), fill = 0;
        while (live()) {
          const { value, done } = await reader.read();
          if (done) {
            if (fill > 0 && start >= 0 && s.next * this.chunkSize + fill === this.size) { this._emit(s, buf.subarray(0, fill)); }
            else if (s.next * this.chunkSize < this.size) throw new Error(`short read at chunk ${s.next}`);
            this.stream = null; return;                                     // reached end of file
          }
          let off = 0;
          while (off < value.byteLength) {
            const room = Math.min(this.chunkSize - fill, value.byteLength - off);
            buf.set(value.subarray(off, off + room), fill); fill += room; off += room;
            if (fill === this.chunkSize) {
              this._emit(s, buf); attempt = 0;
              buf = new Uint8Array(this.chunkSize); fill = 0;
              if (s.next * this.chunkSize >= this.size) { try { await reader.cancel(); } catch {} this.stream = null; return; }
              await pause(); if (!live()) { try { await reader.cancel(); } catch {} return; }
            }
          }
        }
        try { await reader.cancel(); } catch {}
        return;                                                             // superseded by a seek
      } catch (e) {
        if (!live() || s.abort.signal.aborted) return;
        lastError = e; attempt++; this.retries++;
        if (attempt >= MAX_ATTEMPTS) {
          this.stream = null;
          for (const [, d] of s.deferreds) if (!d.settled) d.reject(lastError);
          return;
        }
        await backoff(attempt);
      }
    }
    if (live()) this.stream = null;
  }

  _emit(s, bytes) {
    const index = s.next++;
    const start = index * this.chunkSize;
    const copy = bytes.slice();                                            // buf is reused; hand out a stable copy
    this.bytesFetched += copy.byteLength;
    this._teeMaybe(start, copy);
    const d = this._reserve(s, index);
    if (d && !d.settled) d.resolve(copy); else if (!d) this.chunks.set(index, Promise.resolve(copy));
    s.deferreds.delete(index);
    this._settled(index);
  }

  // One-off fetch of a single chunk (only for chunks orphaned by a seek).
  async _fetchOne(index) {
    const start = index * this.chunkSize, end = Math.min(start + this.chunkSize, this.size) - 1;
    let lastError;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const t0 = Date.now();
      try {
        let res;
        try { res = await this.fetchImpl(this.url, { headers: { Range: `bytes=${start}-${end}` } }); }
        catch (e) { this._log("one", start, e.message, t0); throw e; }
        this.requests++; this._log("one", start, res.status, t0);
        if (!(res.status === 206 || res.status === 200)) throw new Error(`Range fetch failed: ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength < end - start + 1) throw new Error(`short read: ${bytes.byteLength} of ${end - start + 1}`);
        this.bytesFetched += bytes.byteLength;
        this._teeMaybe(start, bytes);
        return bytes;
      } catch (e) { lastError = e; this.retries++; await backoff(attempt); }
    }
    throw lastError;
  }

  // Sequential reads (the playback region) keep the stream running a couple of chunks ahead.
  async read(start, end) {
    if (this.size == null) await this.getSize();
    const first = Math.floor(start / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    const pending = [];
    for (let i = first; i <= last; i++) pending.push(this._fetchChunk(i));
    this._want(Math.min(last + PREFETCH_AHEAD, Math.ceil(this.size / this.chunkSize) - 1));
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

  dispose() { const s = this.stream; this.stream = null; s?.abort.abort(); s?.wake?.(); this.chunks.clear(); this.order.length = 0; this.tee = null; }
}
