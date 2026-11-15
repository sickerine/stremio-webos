// A view of a Matroska file without its Attachments element.
//
// LG's player reads a file from byte 0 in order and works through attached fonts at
// about 5 MB a second before it shows a frame. Anime carries 5 to 70 MB of them, and
// only our own subtitle renderer uses them. The tee serves the player the same file
// with the Attachments element cut out: every byte after it moves down by the cut's
// length, so the three places that store positions (the Segment size, the SeekHead and
// the Cues) are rewritten to match. Offsets handed to the subtitle demuxer stay real.

var M = require('./mkv-subs.js');

var ID = {
    EBML: 0x1a45dfa3, SEGMENT: 0x18538067, SEEKHEAD: 0x114d9b74, SEEK: 0x4dbb, SEEKID: 0x53ab, SEEKPOSITION: 0x53ac,
    TRACKS: 0x1654ae6b, ATTACHMENTS: 0x1941a469, CLUSTER: 0x1f43b675, CUES: 0x1c53bb6b, CUEPOINT: 0xbb, CUETRACKPOSITIONS: 0xb7,
    CUECLUSTERPOSITION: 0xf1, CUECODECSTATE: 0xea, VOID: 0xec, CRC32: 0xbf,
};
var MIN_CUT = 1024 * 1024;   // less than this costs the player a fraction of a second

// The element starting at pos, or null when its header is not all in buf yet.
function element(buf, pos) {
    var id = M.readId(buf, pos); if (!id) return null;
    var size = M.readSize(buf, pos + id.len); if (!size) return null;
    var data = pos + id.len + size.len;
    return { id: id.id, start: pos, sizeAt: pos + id.len, sizeLen: size.len, size: size.value, unknown: size.unknown, data: data, end: data + size.value };
}
// Visits the children of a master we rewrite. A checksum over it would no longer match, so
// a CRC-32 child becomes a Void of the same shape: the master stays valid, only unchecked.
function children(buf, from, to, visit) {
    for (var pos = from; pos < to;) {
        var e = element(buf, pos); if (!e || e.unknown || e.end > to) return;
        if (e.id === ID.CRC32) buf[e.start] = ID.VOID; else visit(e);
        pos = e.end;
    }
}
function readUint(buf, from, to) { var v = 0; for (var i = from; i < to; i++) v = v * 256 + buf[i]; return v; }
function writeUint(buf, from, to, v) { for (var i = to - 1; i >= from; i--) { buf[i] = v % 256; v = Math.floor(v / 256); } }
function lower(buf, from, to, by, floor) { var v = readUint(buf, from, to); if (v >= floor) writeUint(buf, from, to, v - by); }

// plan(head): head holds the file from byte 0. Returns
//   undefined  not enough bytes yet to tell
//   null       nothing to cut (no Attachments before the first Cluster, or a layout this does not handle:
//              a second SeekHead, or Cues the first one does not list, would keep their old positions,
//              and Tracks after the Attachments would not be in the head the subtitle demuxer is given)
//   { start, end, cut, cuesAt, head }
//              the Attachments element spans real bytes [start, end); `head` is the rewritten
//              copy of [0, start); cuesAt is the real offset of a Cues element after the cut
//              that needs cues() before the player sees it, or null.
function plan(head) {
    var ebml = element(head, 0); if (!ebml) return undefined;
    if (ebml.id !== ID.EBML || ebml.unknown) return null;
    var segment = element(head, ebml.end); if (!segment) return undefined;
    if (segment.id !== ID.SEGMENT) return null;
    var attachments = null, tracks = false, inHead = [];
    for (var pos = segment.data; !attachments;) {
        var e = element(head, pos); if (!e) return undefined;
        if (e.id === ID.CLUSTER || e.unknown) return null;
        if (e.id === ID.ATTACHMENTS) { attachments = e; break; }
        if (e.id === ID.TRACKS) tracks = true;
        if (e.id === ID.SEEKHEAD || e.id === ID.CUES) { if (e.end > head.length) return undefined; inHead.push(e); }
        pos = e.end;
    }
    var cut = attachments.end - attachments.start;
    if (cut < MIN_CUT || !tracks) return null;
    var out = Buffer.from(head.slice(0, attachments.start));
    var floor = attachments.end - segment.data;          // positions are counted from the start of the Segment's data
    var cuesAt = null, cuesFound = false, chained = false;
    inHead.forEach(function (e) {
        if (e.id === ID.CUES) { cuesFound = true; return cues(out, { cut: cut, floor: floor }, e.start); }
        children(out, e.data, e.end, function (seek) {
            if (seek.id !== ID.SEEK) return;
            var target = 0, at = null;
            children(out, seek.data, seek.end, function (c) {
                if (c.id === ID.SEEKID) target = readUint(out, c.data, c.end);
                if (c.id === ID.SEEKPOSITION) at = c;
            });
            if (!at) return;
            var position = readUint(out, at.data, at.end);
            if (target === ID.SEEKHEAD) chained = true;
            if (target === ID.ATTACHMENTS) {             // no longer in the file: blank the entry
                var length = seek.end - seek.start;
                if (length - 2 > 126) { chained = true; return; }
                out.fill(0, seek.start, seek.end); out[seek.start] = ID.VOID; out[seek.start + 1] = 0x80 | (length - 2);
                return;
            }
            if (target === ID.CUES) { cuesFound = true; if (position >= floor) cuesAt = segment.data + position; }
            if (position >= floor) writeUint(out, at.data, at.end, position - cut);
        });
    });
    if (chained || !cuesFound) return null;
    if (!segment.unknown) {
        writeUint(out, segment.sizeAt, segment.sizeAt + segment.sizeLen, segment.size - cut);
        out[segment.sizeAt] |= 1 << (8 - segment.sizeLen);
    }
    return { start: attachments.start, end: attachments.end, cut: cut, floor: floor, cuesAt: cuesAt, head: out };
}

// Rewrite the positions (cluster, codec state) of a Cues element held whole in buf at `at`. Rewrites buf.
function cues(buf, plan, at) {
    var e = element(buf, at || 0);
    if (!e || e.id !== ID.CUES || e.unknown || e.end > buf.length) return null;
    children(buf, e.data, e.end, function (point) {
        if (point.id !== ID.CUEPOINT) return;
        children(buf, point.data, point.end, function (positions) {
            if (positions.id !== ID.CUETRACKPOSITIONS) return;
            children(buf, positions.data, positions.end, function (c) {
                if (c.id === ID.CUECLUSTERPOSITION || c.id === ID.CUECODECSTATE) lower(buf, c.data, c.end, plan.cut, plan.floor);   // a codec state of 0 means none
            });
        });
    });
    return buf;
}

module.exports = { plan: plan, cues: cues, element: element, MIN_CUT: MIN_CUT, ID: ID };
