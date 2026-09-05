// When the app page dies, the LG media pipeline it started can keep pulling the
// stream through the tee at line speed for hours (seen on the TV: 100 Mbps, 180% CPU,
// app closed). launch.js touches the tee on every page request; reap() must drop
// every live tee connection once the page has been silent past PAGE_GONE_MS, and a
// paused upstream with no progress past STALL_MS.
var assert = require('node:assert/strict');
var fs = require('fs'); var http = require('http'); var os = require('os'); var path = require('path');
var mkv = require('./mkv-gen');
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-tee-pagegone-'));
var file = path.join(tmp, 'v.mkv'); mkv.build({ path: file, durSec: 30, bitrateBps: 2000000, seed: 5 });
var body = fs.readFileSync(file);
var upstreamClosed = 0;
var upstream = http.createServer(function (req, res) {
    var m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); var a = m ? +m[1] : 0; var b = m && m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
    res.writeHead(206, { 'content-length': b - a + 1, 'content-range': 'bytes ' + a + '-' + b + '/' + body.length, 'accept-ranges': 'bytes', 'content-type': 'video/x-matroska' });
    if (b - a < 4096) return res.end(body.slice(a, b + 1));
    // drip the body forever-ish so the connection stays live like a real player stream
    var pos = a; var t = setInterval(function () { if (pos > b) { clearInterval(t); return res.end(); } var e = Math.min(pos + 65536, b + 1); res.write(body.slice(pos, e)); pos = e; }, 30);
    res.on('close', function () { clearInterval(t); upstreamClosed++; });
});
function finish(err) { if (err) console.error(err && err.stack || err); upstream.close(function () { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(err ? 1 : 0); }); }
upstream.listen(0, '127.0.0.1', function () {
    process.env.ASS_TEE_PORT = String(25000 + (process.pid % 9000));
    process.env.ASS_TEE_PAGE_GONE_MS = '60000';
    var tee = require('../service/ass-tee');
    var fake = Date.now(); tee._setNow(function () { return fake; });
    var src = 'http://127.0.0.1:' + upstream.address().port + '/v.mkv';
    var clientClosed = false, got = 0;
    var req = http.get({ host: '127.0.0.1', port: tee.PORT, path: '/s/' + encodeURIComponent(src), headers: { Range: 'bytes=0-' } }, function (res) {
        res.on('data', function (c) { got += c.length; });
        res.on('close', function () { clientClosed = true; });
        res.on('error', function () {});
    });
    req.on('error', function () {});
    setTimeout(function () {
        try {
            assert.ok(got > 0, 'stream is flowing'); assert.equal(tee.liveCount(), 1, 'one live tee connection');
            // page alive 30s ago -> nothing dropped
            fake += 30000; tee.touchPage(); fake += 30000;
            var r1 = tee.reap(); assert.equal(r1.dropped, 0, 'page seen 30s ago: keep streaming'); assert.equal(tee.liveCount(), 1);
            // page silent for > 60s -> drop
            fake += 31000;
            var r2 = tee.reap(); assert.equal(r2.pageGone, true); assert.equal(r2.dropped, 1, 'page gone: connection dropped'); assert.equal(tee.liveCount(), 0);
        } catch (e) { return finish(e); }
        setTimeout(function () {
            try {
                assert.equal(clientClosed, true, 'player side was closed');
                assert.ok(upstreamClosed >= 1, 'CDN side was closed');
                assert.equal(tee.status(src).liveConns, 0, 'session has no live connections');
            } catch (e) { return finish(e); }
            console.log('page-gone reap: dropped after ' + (91) + 's of page silence; upstream closed=' + upstreamClosed);
            finish();
        }, 300);
    }, 400);
});
