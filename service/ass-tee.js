// Single-download subtitle tee. The patched player points <video>.src at this
// proxy; for every byte range the player requests we fetch it from the CDN ONCE,
// pipe it to the player, AND feed it to the streaming MKV demuxer (mkv-subs.js) —
// subtitles fall out of the exact bytes the player already pulls (no 2nd pull).
//
// It demuxes ALL embedded ASS subtitle tracks (keyed by track number) so the
// client can render whichever track the user SELECTS in Stremio, and switch
// instantly. Header (styles) + fonts are bootstrapped from the file head once
// (a small metadata fetch), so mid-file/resume streams still parse. Verified in
// vactest/ + on-device against a real Demon Slayer BD (zlib-compressed subs).

var http = require('http');
var crypto = require('crypto');
var PX = require('./ass-proxy.js');
var M = require('./mkv-subs.js');
var FI = require('./font-info.js');
var Cut = require('./mkv-cut.js');

var PORT = parseInt(process.env.ASS_TEE_PORT || '11474', 10);
// Each session pins ~18 embedded fonts (multi-MB CJK) + all-track events in RAM,
// so on a memory-tight TV keep only the current stream plus a little grace, and
// evict finished episodes promptly. (Prefetch is off in tee mode, so we never need
// many at once.)
var SESSION_TTL = 6 * 60 * 1000, MAX_SESSIONS = 3;
// Bounded tee read-ahead. Pausing on the FIRST res.write()===false clamps the CDN read
// to within ~16KB (res's highWaterMark) of the player's socket, which pins the DEMUX
// FRONTIER to the player's media buffer — the demuxer then knows subtitles barely
// further ahead than the playhead, and the renderer starves. Let res's writable queue
// grow to CAP instead, resuming at CAP/2: memory stays bounded (it was UNBOUNDED — the
// whole multi-GB file — which is what OOM'd at ~1GB), while the demuxer keeps a real
// head start over the player.
var READAHEAD_CAP = parseInt(process.env.ASS_TEE_READAHEAD || '16777216', 10);   // 16MB
// Anime releases can carry tens of MiB of embedded fonts before their first
// Cluster. Request a generous bounded head window, consume it incrementally, and
// destroy the response as soon as the Cluster arrives. This does NOT download the
// full window for normal files; it removes the old 16 MiB correctness assumption.
var BOOTSTRAP_MAX_BYTES = parseInt(process.env.ASS_TEE_BOOTSTRAP_MAX_BYTES || '134217728', 10); // 128 MiB
var BOOTSTRAP_MAX_ATTEMPTS = parseInt(process.env.ASS_TEE_BOOTSTRAP_ATTEMPTS || '3', 10);
var BOOTSTRAP_RETRY_MS = parseInt(process.env.ASS_TEE_BOOTSTRAP_RETRY_MS || '250', 10);
var BOOTSTRAP_COOLDOWN_MS = parseInt(process.env.ASS_TEE_BOOTSTRAP_COOLDOWN_MS || '2000', 10);
// The player's view of the file is planned from its first bytes (mkv-cut.js). Its requests
// wait that long and no longer; an Attachments element not found in this much stays in.
var CUT_HEAD_MAX = parseInt(process.env.ASS_TEE_CUT_HEAD_MAX || '8388608', 10);    // 8 MiB
var CUT_WAIT_MS = parseInt(process.env.ASS_TEE_CUT_WAIT_MS || '8000', 10);
var CUES_MAX = 16 * 1024 * 1024;
var CUES_WAIT_MS = parseInt(process.env.ASS_TEE_CUES_WAIT_MS || '10000', 10);
var sessions = {};

function keyFor(u) { return crypto.createHash('sha1').update(String(u)).digest('hex').slice(0, 16); }

function Session(cdnUrl) {
    this.cdnUrl = cdnUrl;
    this.pinned = cdnUrl;
    this.tracks = [];              // subtitle tracks in container/ffprobe order == EMBEDDED_ order
    this.subTrackSet = {};         // number -> info (seeds per-request demuxers)
    this.byTrack = {};             // number -> { events:[], seen:{} }
    this.fonts = {};               // name -> Buffer
    this.fontNamesByFile = {};     // name -> [family/full names] (for on-demand loading)
    this.ready = false;            // header/track-list bootstrapped (subTracks seeded)
    this.tracksIn = false;         // the track list is known (before `ready` when the fonts are cut from the view)
    this.bootstrapDone = false;    // tracks in, or bootstrap failed — unblocks feeding
    this._doneCbs = [];            // callbacks waiting on bootstrapDone
    this._readyCbs = [];           // active range demuxers waiting for eventual recovery
    this.bootstrapRunning = false;
    this.bootstrapAttempts = 0;
    this.bootstrapLimitReached = false;
    this.nextBootstrapAt = 0;
    this._bootstrapTimer = null;
    this.pinDone = false;          // resolver redirect followed and the player's view decided (or failed once)
    this._pinCbs = [];             // player requests wait here instead of racing /resolve
    this.size = null;              // the file's real length
    this.cut = undefined;          // the player's view: undefined until planned, null = the file as it is, else a mkv-cut plan
    this._head = [];               // first bytes of the file, kept until the view is planned
    this._headLength = 0; this._headPlanned = 0;
    this.cues = null;              // { start, end, data }: the Cues element rewritten for a cut view
    this._cuesCbs = null;
    this.refreshRunning = false;   // expired temporary CDN URL is refreshed single-flight
    this._refreshCbs = [];
    this.liveConns = 0;            // open tee connections (never evict while >0)
    this.demuxedBytes = 0;         // bytes walked by a per-connection demuxer
    this.passthroughBytes = 0;     // bytes piped to the player without demuxing (no text subs)
    this.videoFps = null;          // exact fps from the container (video DefaultDuration)
    this.lastActivity = Date.now();
    var self = this;
    setTimeout(function () { self._finishPin(); }, CUT_WAIT_MS).unref();   // a stalled head must not hold the player
    this.ensureBootstrap();
}
Session.prototype._finishPin = function () {
    if (this.pinDone) return;
    // Released before a view was planned: the player gets the file as it is. Decided
    // once per session, because every offset the player uses afterwards depends on it.
    if (this.cut === undefined) this.cut = null;
    this._head = null;
    this.pinDone = true;
    var cbs = this._pinCbs; this._pinCbs = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
};
Session.prototype.whenPinned = function (cb) {
    if (this.pinDone) { cb(); return; }
    this._pinCbs.push(cb);
};
Session.prototype._finishRefresh = function () {
    this.refreshRunning = false;
    var cbs = this._refreshCbs; this._refreshCbs = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
};
// TorBox's redirect target is temporary, while cdnUrl (/resolve/...) is stable.
// If the pinned target expires, exactly one request goes back through the
// resolver. Concurrent player ranges wait for that refresh, then use the new
// target instead of stampeding the resolver.
Session.prototype.fetchPlayerRange = function (range, cb, afterRefresh) {
    var self = this;
    if (self.refreshRunning && !afterRefresh) {
        self._refreshCbs.push(function () { self.fetchPlayerRange(range, cb, true); });
        return;
    }
    var attempted = self.pinned;
    PX.fetchRange(attempted, range, function (err, up, finalUrl) {
        var stalePin = attempted !== self.cdnUrl;
        var failed = err || !up || up.statusCode >= 400;
        if (failed && stalePin && !afterRefresh) {
            try { if (up) { up.resume(); up.destroy(); } } catch (e) {}
            if (self.refreshRunning) {
                self._refreshCbs.push(function () { self.fetchPlayerRange(range, cb, true); });
                return;
            }
            self.refreshRunning = true;
            PX.fetchRange(self.cdnUrl, range, function (refreshErr, refreshUp, refreshUrl) {
                if (!refreshErr && refreshUp && refreshUp.statusCode < 400 && refreshUrl && /^https?:/.test(refreshUrl) && refreshUrl.indexOf('/resolve/') < 0)
                    self.pinned = refreshUrl;
                self._finishRefresh();
                cb(refreshErr, refreshUp, refreshUrl);
            });
            return;
        }
        if (!failed && finalUrl && finalUrl !== self.pinned && /^https?:/.test(finalUrl) && finalUrl.indexOf('/resolve/') < 0)
            self.pinned = finalUrl;
        cb(err, up, finalUrl);
    });
};
Session.prototype._finishBootstrap = function () {
    if (this.bootstrapDone) return;
    this.bootstrapDone = true;
    var cbs = this._doneCbs; this._doneCbs = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
};
Session.prototype.whenBootstrapDone = function (cb) {
    if (this.bootstrapDone) { cb(); return; }
    this._doneCbs.push(cb);
};
Session.prototype._finishReady = function () {
    var cbs = this._readyCbs; this._readyCbs = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
};
Session.prototype.whenReady = function (cb) {
    if (this.ready) { cb(); return function () {}; }
    this._readyCbs.push(cb);
    var self = this;
    return function () {
        var i = self._readyCbs.indexOf(cb);
        if (i >= 0) self._readyCbs.splice(i, 1);
    };
};
Session.prototype.ensureBootstrap = function () {
    if (this.ready || this.bootstrapRunning || this.bootstrapLimitReached || Date.now() < this.nextBootstrapAt) return;
    this.bootstrapRunning = true;
    this.bootstrapAttempts++;
    this._bootstrap();
};
Session.prototype._bootstrapFailed = function () {
    var self = this;
    if (self.ready) return;
    self.bootstrapRunning = false;
    if (self.bootstrapAttempts < BOOTSTRAP_MAX_ATTEMPTS) {
        var delay = BOOTSTRAP_RETRY_MS * self.bootstrapAttempts;
        self.nextBootstrapAt = Date.now() + delay;
        clearTimeout(self._bootstrapTimer);
        self._bootstrapTimer = setTimeout(function () {
            self._bootstrapTimer = null;
            self.ensureBootstrap();
        }, delay);
        return;
    }
    // Do not poison the cached session forever. Unblock playback after this
    // bounded burst, then let the controller's status polling start a new burst.
    self.bootstrapAttempts = 0;
    self.nextBootstrapAt = Date.now() + BOOTSTRAP_COOLDOWN_MS;
    self._finishBootstrap();
};
Session.prototype._bucket = function (tn) { return this.byTrack[tn] || (this.byTrack[tn] = { events: [], seen: Object.create(null) }); };
Session.prototype._sink = function () {
    var self = this;
    return {
        onFont: function (f) {
            if (!f.name || !f.data || self.fonts[f.name]) return;
            if (!FI.isFontAttachment(f.name, f.mime)) return;
            self.fonts[f.name] = f.data;
            self.fontNamesByFile[f.name] = FI.fontNames(f.data).names;         // for on-demand loading
        },
        onEvent: function (line, coff, tn) { var b = self._bucket(tn); if (!b.seen[line]) { b.seen[line] = 1; b.events.push(line); } },
    };
};
// The player may resume MID-FILE (no Tracks header in its stream), so bootstrap
// the track list + styles + fonts once from the file head — a small fetch that
// stops at the first Cluster, NOT the whole file.
Session.prototype._bootstrap = function () {
    var self = this;
    var hd = new M.MkvSubDemux(self._sink());
    hd.allSubs = true;
    var off = 0;
    var settled = false;
    function failed() {
        if (settled) return;
        settled = true;
        self._finishPin();
        self._bootstrapFailed();
    }
    if (self._head) { self._head = []; self._headLength = 0; self._headPlanned = 0; }
    PX.fetchRange(self.pinned, 'bytes=0-' + (BOOTSTRAP_MAX_BYTES - 1), function (err, up, finalUrl) {
        if (err || !up) { self._finishPin(); failed(); return; }
        if (finalUrl && finalUrl !== self.pinned && /^https?:/.test(finalUrl) && finalUrl.indexOf('/resolve/') < 0) self.pinned = finalUrl;
        var total = /\/(\d+)\s*$/.exec(up.headers['content-range'] || '');
        if (total) self.size = +total[1];
        up.on('data', function (c) {
            var remaining = BOOTSTRAP_MAX_BYTES - off;
            if (remaining <= 0) return;
            if (c.length > remaining) c = c.slice(0, remaining);
            if (self._head) self._planView(c);
            try { hd.pushAt(off, c); } catch (e) {}
            off += c.length;
            // With the fonts cut from the player's view the picture starts, and a resume reaches
            // the middle of the file, while they are still coming in. The tracks are complete
            // by then: list them, so dialogue shows at once and mid-file streams are read.
            if (self.cut && !self.tracksIn && hd.tracks.length && hd._sPos >= self.cut.start) { self._adoptTracks(hd); self._finishBootstrap(); }
            if (hd._curCluster && !self.ready) {         // header+fonts done -> capture tracks
                settled = true;
                if (self._head) self._planView();
                self._adoptTracks(hd);
                self.ready = true;
                self.bootstrapRunning = false;
                self.bootstrapAttempts = 0;
                self.nextBootstrapAt = 0;
                self._finishBootstrap();                     // unblock the mid-file demuxers (now seedable)
                self._finishReady();                         // seed demuxers created after an earlier failed burst
                try { up.destroy(); } catch (e) {}
            } else if (off >= BOOTSTRAP_MAX_BYTES) {
                // A malformed/pathological file must not make status polling
                // redownload the same maximum-size prefix forever.
                settled = true;
                self._finishPin();
                self.bootstrapRunning = false;
                self.bootstrapAttempts = 0;
                self.bootstrapLimitReached = true;
                self._finishBootstrap();
                try { up.destroy(); } catch (e) {}
            }
        });
        // Head exhausted / upstream error before a Cluster: retry instead of
        // preserving a permanently trackless session. The bounded retry burst
        // eventually unblocks playback; later status polls can recover it.
        up.on('end', failed);
        up.on('error', failed);
    });
};
Session.prototype._adoptTracks = function (hd) {
    this.subTrackSet = hd.subTracks;
    this.tracks = Object.keys(hd.subTracks).map(function (n) { return { number: +n, streamIndex: hd.subTracks[n].streamIndex, name: hd.subTracks[n].name, lang: hd.subTracks[n].lang, codecPrivate: hd.subTracks[n].codecPrivate }; }).sort(function (a, b) { return a.streamIndex - b.streamIndex || a.number - b.number; });
    this.videoFps = hd.videoFps();               // exact container fps for sign frame-lock
    this.tracksIn = true;
};
// Plan the player's view from the head of the file. The Attachments element's header
// arrives long before its contents, so the player is released after a few KB while this
// bootstrap carries on reading the fonts.
// Without a chunk: the bootstrap has stopped reading, so decide with what is here.
Session.prototype._planView = function (chunk) {
    if (chunk) {
        this._head.push(chunk); this._headLength += chunk.length;
        if (this._headLength < this._headPlanned * 2 && this._headLength < CUT_HEAD_MAX) return;   // plan again once the head has doubled
    }
    this._headPlanned = this._headLength;
    var head = Buffer.concat(this._head);
    var plan = this.size ? Cut.plan(head) : null;
    if (plan === undefined && chunk && this._headLength < CUT_HEAD_MAX) return;
    if (plan && plan.start > CUT_HEAD_MAX) plan = null;
    if (plan) { plan.raw = Buffer.from(head.slice(0, plan.start)); this.cut = plan; }
    this._finishPin();
    if (plan && plan.cuesAt != null) this.loadCues(function () {});     // the player's first seek asks for it: have it by then
};
// The Cues element of a cut view: fetched once, when the player first asks for it (its
// first seek), and rewritten. cb(false) when it cannot be had.
Session.prototype.loadCues = function (cb) {
    var self = this, cut = this.cut;
    if (this.cues) return cb(true);
    if (this._cuesCbs) { this._cuesCbs.push(cb); return; }
    var cbs = this._cuesCbs = [cb], upstream = null, settled = false;
    // Every way out goes through here: a CDN that stalls or sends something else must not
    // leave the fetch open or the waiting player requests hanging.
    function done(ok) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { if (upstream) { upstream.resume(); upstream.destroy(); } } catch (e) {}
        if (self._cuesCbs === cbs) self._cuesCbs = null;
        cbs.forEach(function (f) { f(ok); });
    }
    var timer = setTimeout(function () { done(false); }, CUES_WAIT_MS);
    this.fetchPlayerRange('bytes=' + cut.cuesAt + '-', function (err, up) {
        upstream = up;
        if (settled) { try { if (up) { up.resume(); up.destroy(); } } catch (e) {} return; }   // timed out before the CDN answered
        if (err || !up || up.statusCode !== 206) return done(false);        // 200 would be the file from byte 0
        var parts = [], length = 0, want = 0;
        up.on('data', function (c) {
            if (settled) return;
            parts.push(c); length += c.length;
            if (!want) {
                var e = Cut.element(Buffer.concat(parts), 0);
                if (!e && length < 16) return;                              // an element header is at most 12 bytes
                if (!e || e.id !== Cut.ID.CUES || e.unknown || e.end > CUES_MAX) return done(false);
                want = e.end;
            }
            if (length < want) return;
            var data = Buffer.concat(parts).slice(0, want);
            Cut.cues(data, cut, 0);
            self.cues = { start: cut.cuesAt, end: cut.cuesAt + want, data: data };
            done(true);
        });
        up.on('end', function () { done(false); });
        up.on('error', function () { done(false); });
    });
};
// Per-connection demuxer (concurrent-safe), demuxing all sub tracks. Seeded from
// the bootstrapped track map when ready; a start-at-0 stream self-seeds from the
// Tracks header in its own bytes so it does not need the seed.
// A file with no S_TEXT (ASS/SSA/SRT) tracks has nothing for the tee to extract:
// PGS/VobSub are bitmaps the player renders itself. Walking every byte of a 4K
// stream through the EBML parser for nothing cost ~150% CPU on the TV.
Session.prototype.hasTextSubs = function () { return !this.ready || Object.keys(this.subTrackSet).length > 0; };
Session.prototype.newDemux = function () {
    var d = new M.MkvSubDemux(this._sink());
    d.allSubs = true;
    if (this.tracksIn) d.subTracks = this.subTrackSet;
    return d;
};
Session.prototype.list = function () {
    var self = this;
    return this.tracks.map(function (t, i) { var b = self.byTrack[t.number]; return { index: i, number: t.number, streamIndex: t.streamIndex, name: t.name, lang: t.lang, events: b ? b.events.length : 0 }; });
};
// ASS timecode "H:MM:SS.cc" -> seconds.
function tcSec(s) { var m = /(\d+):(\d\d):(\d\d)[.,](\d+)/.exec(s); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+('0.' + m[4])) : 0; }
// Windowed track text. Heavy-typesetting tracks (per-frame mocha signs) can be tens
// of MB / tens of thousands of events; handing all of it to libass every frame starves
// rendering. When tSec/winSec are given, return only events OVERLAPPING [t-win, t+win]
// so libass parses/holds a small slice around the playhead.
Session.prototype.trackText = function (index, tSec, winSec) {
    var t = this.tracks[index]; if (!t || !t.codecPrivate) return '';
    var h = t.codecPrivate.toString('utf8'); if (h[h.length - 1] !== '\n') h += '\n';
    var b = this.byTrack[t.number];
    if (!b || !b.events.length) return h;
    var events = b.events;
    if (tSec != null && winSec > 0) {
        var lo = tSec - winSec, hi = tSec + winSec;
        events = events.filter(function (line) {
            var m = /^Dialogue:[^,]*,([^,]+),([^,]+),/.exec(line);
            if (!m) return true;                                  // keep anything unparseable
            return tcSec(m[2]) >= lo && tcSec(m[1]) <= hi;        // event overlaps the window
        });
    }
    return h + events.join('\n') + '\n';
};
// Split embedded fonts into on-demand (avail) vs always-load (eager). A font is safe
// on-demand — loaded by JASSUB only when the ASS references its name — ONLY if none of
// the names it provides is shared with another file. Multi-face families (Regular/Bold/
// Italic in separate files, which share a family name) and unparseable fonts stay eager,
// because availableFonts maps one name -> one file and would otherwise drop faces.
Session.prototype.fontPlan = function () {
    var self = this, files = Object.keys(this.fonts);
    var owners = {};
    files.forEach(function (fn) { (self.fontNamesByFile[fn] || []).forEach(function (nm) { owners[nm] = (owners[nm] || 0) + 1; }); });
    var avail = {}, eager = [];
    files.forEach(function (fn) {
        var names = self.fontNamesByFile[fn] || [];
        var safe = names.length && names.every(function (nm) { return owners[nm] === 1; });
        if (safe) names.forEach(function (nm) { avail[nm] = fn; });
        else eager.push(fn);
    });
    return { avail: avail, eager: eager };
};

function gc(except) {
    var now = Date.now(), keys = Object.keys(sessions);
    // Never evict a session that has open tee connections (it's being watched).
    function evictable(k) { return k !== except && sessions[k].liveConns <= 0; }
    keys.forEach(function (k) { if (evictable(k) && now - sessions[k].lastActivity > SESSION_TTL) delete sessions[k]; });
    keys = Object.keys(sessions);
    if (keys.length > MAX_SESSIONS) {
        keys.sort(function (a, b) { return sessions[a].lastActivity - sessions[b].lastActivity; });
        var over = keys.length - MAX_SESSIONS;
        for (var i = 0; i < keys.length && over > 0; i++) { if (evictable(keys[i])) { delete sessions[keys[i]]; over--; } }
    }
}
function ensure(cdnUrl) {
    var key = keyFor(cdnUrl);
    if (!sessions[key]) sessions[key] = new Session(cdnUrl);
    sessions[key].lastActivity = Date.now();
    gc(key);
    return sessions[key];
}

// ---- liveness ------------------------------------------------------------------
// The app page hits launch.js every few seconds while it is alive (library poll,
// posters, status). If it dies (webOS kills the foreground app under memory
// pressure) the LG media pipeline it started can outlive it and keep pulling the
// stream through us at line speed for hours. So: launch.js calls touchPage() on
// every page request, and reap() drops every live tee connection once the page
// has been silent for PAGE_GONE_MS, plus any upstream that sat paused with no
// progress for STALL_MS (a client that vanished without closing its socket).
var PAGE_GONE_MS = parseInt(process.env.ASS_TEE_PAGE_GONE_MS || '60000', 10);
var STALL_MS = parseInt(process.env.ASS_TEE_STALL_MS || '120000', 10);
var _now = function () { return Date.now(); };
var lastPageActivity = _now();
var live = [];                      // [{ up, res, sess, progressAt }]
function touchPage() { lastPageActivity = _now(); }
function dropConn(c, why) {
    var i = live.indexOf(c); if (i >= 0) live.splice(i, 1);
    try { if (c.up) { c.up.destroy(); } } catch (e) {}
    try { if (c.res) { c.res.destroy(); } } catch (e) {}
    c.dropped = why;
}
function reap() {
    var now = _now(), dropped = 0;
    var pageGone = live.length > 0 && (now - lastPageActivity) > PAGE_GONE_MS;
    live.slice().forEach(function (c) {
        if (pageGone) { dropConn(c, 'page-gone'); dropped++; }
        else if (c.res && (c.res.destroyed || c.res.writableEnded)) { dropConn(c, 'dead-response'); dropped++; }
        else if (c.paused && (now - c.progressAt) > STALL_MS) { dropConn(c, 'stalled'); dropped++; }
    });
    return { dropped: dropped, live: live.length, pageGone: pageGone };
}

// ---- the tee HTTP server (the player streams THROUGH this) -------------------
var tee = http.createServer(function (req, res) {
    var path = (req.url || '/').split('?')[0];
    var m = /^\/s\/(.+)$/.exec(path);
    if (!m) { res.writeHead(404); res.end(); return; }
    var cdnUrl = decodeURIComponent(m[1]);
    var sess = ensure(cdnUrl);
    var range = req.headers.range || '';
    var rm = /bytes=(\d+)-(\d*)/.exec(range);
    var start = rm ? parseInt(rm[1], 10) : 0;
    // The demuxer only yields subtitles once its subTracks map exists. A stream
    // starting at byte 0 carries the Tracks header and self-seeds, so it can demux
    // immediately. A MID-FILE stream (resume/seek) has NO header — if we feed it
    // before _bootstrap has seeded subTracks, every block is rejected as non-sub
    // and its events are lost until a later seek re-fetches with a ready session.
    // So: buffer a mid-file stream's bytes (bounded) until bootstrapDone, then make
    // the (now-seedable) demuxer and flush.
    var demux = null, pre = [], preLen = 0, closed = false;
    function makeDemux() {
        if (demux) return;
        if (!sess.hasTextSubs()) { pre = null; return; }                 // nothing to extract: pure passthrough
        demux = sess.newDemux();
        if (pre) { for (var i = 0; i < pre.length; i++) { try { demux.pushAt(pre[i][0], pre[i][1]); } catch (e) {} } pre = null; }
    }
    if (start === 0) makeDemux();
    else sess.whenBootstrapDone(function () {
        if (!demux) makeDemux();
        else if (sess.tracksIn) { demux.subTracks = sess.subTrackSet; }   // seed a demuxer forced early by pre-buffer overflow
    });
    var cancelReady = sess.whenReady(function () {
        if (closed) return;
        if (!sess.hasTextSubs()) { demux = null; pre = null; return; }   // bootstrap found no text tracks: stop demuxing
        if (!demux) makeDemux();
        if (demux) demux.subTracks = sess.subTrackSet;
    });
    sess.liveConns++;
    function closeConn() { if (!closed) { closed = true; cancelReady(); sess.liveConns = Math.max(0, sess.liveConns - 1); sess.lastActivity = Date.now(); pre = null; preLen = 0; } }   // release the pre-bootstrap buffer (up to 16MB)
    // The player (LG's pipeline) opens probe connections and aborts them within
    // milliseconds. If we only listened for 'close' after the upstream connected, an
    // abort in that window was never seen: we then streamed the whole file into a
    // dead response, and because Node reports each dropped write through the callback,
    // the backpressure counter kept draining and the upstream was never paused (seen
    // on the TV: 200 Mbps + 100% CPU with no client, until the app was restarted).
    var clientGone = false;
    function onClientGone() { clientGone = true; closeConn(); }
    res.on('close', onClientGone); res.on('error', onClientGone); req.on('aborted', onClientGone);
    // One upstream response into the player. Bytes reach the demuxer at their real offset
    // and the player under bounded read-ahead; `done` gets the offset the response ended at.
    function pipe(up, off, done) {
        var pending = 0, paused = false;
        var conn = { up: up, res: res, sess: sess, paused: false, progressAt: _now() };
        live.push(conn);
        // BACKPRESSURE, bounded (critical, and delicate — read before changing):
        //  * No pause at all  -> the whole multi-GB file lands in res's writable queue
        //                        in RAM -> ~1GB RSS -> OOM at stream start.
        //  * Pause on the first write()===false -> the CDN read is clamped to res's 16KB
        //                        highWaterMark, so the demuxer only ever parses as far
        //                        ahead as the player has buffered. The subtitle renderer
        //                        then runs dry and subs vanish mid-episode.
        // So: allow up to READAHEAD_CAP bytes in flight, resume at half (hysteresis, to
        // avoid pause/resume churn every 16KB). Memory bounded; demuxer keeps a lead.
        function unregister() { var i = live.indexOf(conn); if (i >= 0) live.splice(i, 1); }
        function stopUpstream() { closeConn(); unregister(); try { up.destroy(); } catch (e) {} }
        function wrote(n) { return function (err) {
            if (err || clientGone) { stopUpstream(); return; }
            pending -= n; conn.progressAt = _now(); if (paused && pending <= (READAHEAD_CAP >> 1)) { paused = false; conn.paused = false; try { up.resume(); } catch (e) {} } }; }
        up.on('data', function (c) {
            if (clientGone || res.destroyed || res.writableEnded) { stopUpstream(); return; }
            if (demux) { sess.demuxedBytes += c.length; try { demux.pushAt(off, c); } catch (e) {} }
            else if (pre) {                                                            // still buffering (not closed)
                if (preLen < 16777216) { pre.push([off, c]); preLen += c.length; }     // buffer until bootstrapDone
                else { makeDemux(); if (demux) { try { demux.pushAt(off, c); } catch (e) {} } }   // overflow: proceed best-effort
            }
            else sess.passthroughBytes += c.length;
            off += c.length;
            try {
                pending += c.length;
                res.write(c, wrote(c.length));
                if (pending > READAHEAD_CAP && !paused) { paused = true; conn.paused = true; up.pause(); }
            } catch (e) {}
        });
        up.on('end', function () { sess.lastActivity = Date.now(); unregister(); res.removeListener('close', stopUpstream); done(off); });
        up.on('error', function () { unregister(); try { res.end(); } catch (e) {} });
        res.on('close', stopUpstream);
    }
    function finish() { try { res.end(); } catch (e) {} }
    function refuse(up) { closeConn(); try { if (up) { up.resume(); up.destroy(); } } catch (e) {} try { res.destroy(); } catch (e) {} }
    // The file as it is: the CDN's own status and headers.
    function whole() {
        sess.fetchPlayerRange(range, function (err, up) {
            if (clientGone) { try { if (up) { up.resume(); up.destroy(); } } catch (e) {} return; }
            if (err || !up) { closeConn(); try { res.writeHead(502); res.end(); } catch (e) {} return; }
            var h = {};
            ['content-length', 'content-range', 'accept-ranges', 'content-type'].forEach(function (k) { if (up.headers[k]) h[k] = up.headers[k]; });
            try { res.writeHead(up.statusCode, h); } catch (e) { closeConn(); try { up.destroy(); } catch (x) {} return; }
            pipe(up, start, finish);
        });
    }
    // The file without its Attachments element (mkv-cut.js). The player's offsets are
    // this view's; what is fetched and demuxed keeps the file's real offsets.
    function cutView(cut) {
        var total = sess.size - cut.cut;
        var last = rm && rm[2] ? Math.min(parseInt(rm[2], 10), total - 1) : total - 1;
        if (start > last) { closeConn(); try { res.writeHead(416, { 'content-range': 'bytes */' + total }); res.end(); } catch (e) {} return; }
        var h = { 'content-type': 'video/x-matroska', 'accept-ranges': 'bytes', 'content-length': last - start + 1 };
        // A Range form this does not read (a suffix, several ranges) gets the whole view, as HTTP allows.
        if (rm) h['content-range'] = 'bytes ' + start + '-' + last + '/' + total;
        try { res.writeHead(rm ? 206 : 200, h); } catch (e) { closeConn(); return; }
        if (start < cut.start) {
            if (demux && start === 0) { try { demux.pushAt(0, cut.raw); } catch (e) {} }      // the tracks: the demuxer never sees them otherwise
            res.write(cut.head.slice(start, Math.min(cut.start, last + 1)));
        }
        if (last < cut.start) return finish();
        var end = last + cut.cut;                                    // real offset of the last byte wanted
        (function next(pos) {
            if (clientGone) return;
            if (pos > end) return finish();
            if (cut.cuesAt != null && pos >= cut.cuesAt && (!sess.cues || pos < sess.cues.end)) {
                if (!sess.cues) return sess.loadCues(function (ok) { if (ok) next(pos); else refuse(); });
                res.write(sess.cues.data.slice(pos - sess.cues.start, Math.min(sess.cues.end, end + 1) - sess.cues.start));
                return next(sess.cues.end);
            }
            var stop = cut.cuesAt != null && pos < cut.cuesAt ? Math.min(end, cut.cuesAt - 1) : end;
            sess.fetchPlayerRange('bytes=' + pos + '-' + stop, function (err, up) {
                if (clientGone) { try { if (up) { up.resume(); up.destroy(); } } catch (e) {} return; }
                if (err || !up || up.statusCode !== 206) return refuse(up);                // 200 would be the file from byte 0
                // A response that ends early must end the player's too: carrying on would
                // hand it a stream with a hole in it.
                pipe(up, pos, function (reached) { if (reached === stop + 1) next(stop + 1); else refuse(); });
            });
        })(Math.max(start, cut.start) + cut.cut);
    }
    sess.whenPinned(function () {
        if (clientGone) return;
        if (sess.cut) cutView(sess.cut); else whole();
    });
});
tee.on('clientError', function (e, sock) { try { sock.destroy(); } catch (x) {} });
try { tee.listen(PORT, '127.0.0.1'); } catch (e) {}

// ---- API used by launch.js routes -------------------------------------------
function status(cdnUrl) {
    var s = sessions[keyFor(cdnUrl)];
    if (!s) return { state: 'none', ready: false, tracks: [] };
    s.lastActivity = Date.now();   // the client poll is a heartbeat — keep the session alive
    s.ensureBootstrap();           // failed bursts cool down, then recover instead of staying poisoned
    var fp = s.fontPlan();
    return { state: s.ready ? 'streaming' : 'probing', ready: s.ready, tracks: s.list(), fonts: Object.keys(s.fonts), fontAvail: fp.avail, fontEager: fp.eager, videoFps: s.videoFps,
             textSubs: s.hasTextSubs(), demuxedBytes: s.demuxedBytes, passthroughBytes: s.passthroughBytes, liveConns: s.liveConns };
}
function trackText(cdnUrl, index, tSec, winSec) { var s = sessions[keyFor(cdnUrl)]; if (!s) return ''; s.lastActivity = Date.now(); return s.trackText(index | 0, tSec, winSec); }
function fontData(cdnUrl, name) { var s = sessions[keyFor(cdnUrl)]; if (!s) return null; s.lastActivity = Date.now(); return s.fonts[name] || null; }
function teeUrl(cdnUrl) { return 'http://127.0.0.1:' + PORT + '/s/' + encodeURIComponent(cdnUrl); }

module.exports = { status: status, trackText: trackText, fontData: fontData, teeUrl: teeUrl, keyFor: keyFor, PORT: PORT, _sessions: sessions,
    touchPage: touchPage, reap: reap, liveCount: function () { return live.length; },
    _setNow: function (fn) { _now = fn || function () { return Date.now(); }; lastPageActivity = _now(); } };
