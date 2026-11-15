// Multi-sub anime releases attach fonts of many megabytes (one Crunchyroll rip
// carries an 18 MB Arial Unicode). The streaming demuxer waits for such a leaf to
// arrive whole. It must not re-copy everything it holds on each arriving chunk:
// on the TV that took about 50 s per pass and playback could not start.
var assert = require('node:assert/strict');
var fs = require('fs'); var os = require('os'); var path = require('path');
var mkv = require('./mkv-gen'); var M = require('../service/mkv-subs');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-bigfont-'));
var font = Buffer.alloc(3 * 1024 * 1024);
for (var i = 0; i < font.length; i += 4093) font[i] = (i / 4093) & 255;
var file = path.join(tmp, 'v.mkv');
mkv.build({ path: file, durSec: 4, bitrateBps: 1e6,
    events: [{ start: 0.25, end: 1.5, text: 'Dialogue', style: 'Default' }],
    attachments: [{ name: 'Big Font.ttf', mime: 'font/ttf', data: font }] });
var buf = fs.readFileSync(file);
fs.rmSync(tmp, { recursive: true, force: true });

var fonts = [], events = 0, copied = 0;
var realConcat = Buffer.concat;
Buffer.concat = function (list, length) { var out = realConcat.call(Buffer, list, length); copied += out.length; return out; };
var demux = new M.MkvSubDemux({ onEvent: function () { events++; }, onFont: function (f) { fonts.push(f); } });
demux.allSubs = true;
for (var o = 0; o < buf.length; o += 16384) demux.pushAt(o, buf.subarray(o, Math.min(o + 16384, buf.length)));
Buffer.concat = realConcat;

assert.equal(fonts.length, 1, 'the attached font is extracted');
assert.ok(fonts[0].data.equals(font), 'its bytes are intact');
assert.ok(events > 0, 'subtitles after the font are still read');
assert.ok(copied < buf.length * 4, 'bytes copied (' + (copied / 1e6).toFixed(0) + ' MB) stay proportional to the file (' + (buf.length / 1e6).toFixed(0) + ' MB)');
console.log('mkv-subs large font: extracted intact, ' + (copied / 1e6).toFixed(1) + ' MB copied for a ' + (buf.length / 1e6).toFixed(1) + ' MB file');

// Each element is handed over when its last byte is in. Waiting longer left the subtitle
// side a font behind the stream: with an 18 MB font ahead of it, megabytes behind.
(function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-fontlag-'));
    var target = path.join(dir, 'v.mkv');
    var built = mkv.build({ path: target, durSec: 2, bitrateBps: 1e6, events: [],
        attachments: [{ name: 'first.ttf', mime: 'font/ttf', data: Buffer.alloc(300 * 1024, 1) }, { name: 'second.ttf', mime: 'font/ttf', data: Buffer.alloc(200 * 1024, 2) }] });
    var bytes = fs.readFileSync(target);
    fs.rmSync(dir, { recursive: true, force: true });
    var seen = [];
    var d = new M.MkvSubDemux({ onFont: function (f) { seen.push(f.name); }, onEvent: function () {} });
    d.allSubs = true;
    // feed the header only: everything before the first Cluster, in uneven pieces
    for (var at = 0, n = 0; at < built.headerLen; n++) { var size = Math.min(built.headerLen - at, 1000 + (n * 7919) % 15000); d.pushAt(at, bytes.subarray(at, at + size)); at += size; }
    assert.deepEqual(seen, ['first.ttf', 'second.ttf'], 'both fonts are out once the header is in, with no picture data fed');
    assert.equal(Object.keys(d.subTracks).length, 1, 'and so is the track list');
    console.log('mkv-subs large font: elements are handed over as their last byte arrives');
})();
