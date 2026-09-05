// The streaming demuxer skips video/audio blocks from their track vint without
// buffering them (the copying was ~200% CPU on the TV at 4K). Skipping must not
// change what is extracted: streaming in small chunks, from byte 0 or mid-file,
// must yield exactly the events a whole-buffer parse yields.
var assert = require('node:assert/strict');
var fs = require('fs'); var os = require('os'); var path = require('path');
var mkv = require('./mkv-gen'); var M = require('../service/mkv-subs');
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-skip-'));
function events(run) { var ev = []; var d = new M.MkvSubDemux({ onEvent: function (l) { ev.push(l); }, onFont: function () {} }); d.allSubs = true; run(d); return { ev: ev, d: d }; }
var cases = [['S_TEXT/ASS', 4e6, 90], ['S_TEXT/UTF8', 2e6, 90], ['S_TEXT/ASS', 60e6, 40]];   // seed 11 gives dozens of events
var total = 0;
cases.forEach(function (c) {
    var f = path.join(tmp, 'v.mkv'); mkv.build({ path: f, durSec: c[2], bitrateBps: c[1], seed: 11, subtitleCodec: c[0] }); var buf = fs.readFileSync(f);
    // reference: the whole file in ONE push (every block fully present, so the
    // skip path is never exercised across a chunk boundary)
    var whole = events(function (d) { d.pushAt(0, buf); }).ev;
    assert.ok(whole.length > 5, c[0] + ': fixture has subtitle events (' + whole.length + ')');
    [65536, 16384, 4096, 1500].forEach(function (CH) {
        var streamed = events(function (d) { for (var o = 0; o < buf.length; o += CH) d.pushAt(o, buf.subarray(o, Math.min(o + CH, buf.length))); }).ev;
        assert.deepEqual(streamed, whole, c[0] + ' @' + (c[1] / 1e6) + 'Mbps chunk=' + CH + ': chunked stream equals single-push reference');
        total++;
    });
    // mid-file resume: seed the track map from the header (as the tee does), then stream from a third in
    var seed = new M.MkvSubDemux({ onEvent: function () {}, onFont: function () {} }); seed.allSubs = true; seed.pushAt(0, buf.subarray(0, 262144));
    var start = Math.floor(buf.length / 3);
    var mid = events(function (d) { d.subTracks = seed.subTracks; for (var o = start; o < buf.length; o += 16384) d.pushAt(o, buf.subarray(o, Math.min(o + 16384, buf.length))); }).ev;
    assert.ok(mid.length > 0 && mid.length < whole.length, c[0] + ': mid-file stream yields a strict subset (' + mid.length + ' of ' + whole.length + ')');
    mid.forEach(function (l) { assert.ok(whole.indexOf(l) >= 0, 'mid-file event exists in whole parse'); });
    total++;
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log('mkv-subs stream skip: ' + total + ' parity cases passed');
