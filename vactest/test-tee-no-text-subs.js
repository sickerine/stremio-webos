// A file whose only subtitles are bitmaps (PGS) has nothing for the tee to extract.
// The tee must pipe it through WITHOUT running the EBML demuxer on every byte
// (that was ~150% CPU on the TV for a 4K remux). A file with an ASS track is the
// control: it must still be demuxed.
var assert = require('node:assert/strict');
var fs = require('fs'); var http = require('http'); var os = require('os'); var path = require('path');
var mkv = require('./mkv-gen');
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-tee-notext-'));
var pgs = path.join(tmp, 'pgs.mkv'), ass = path.join(tmp, 'ass.mkv');
mkv.build({ path: pgs, durSec: 6, bitrateBps: 800000, seed: 3, subtitleCodec: 'S_HDMV/PGS' });
mkv.build({ path: ass, durSec: 6, bitrateBps: 800000, seed: 3, subtitleCodec: 'S_TEXT/ASS' });
var files = { '/pgs.mkv': fs.readFileSync(pgs), '/ass.mkv': fs.readFileSync(ass) };
var upstream = http.createServer(function (req, res) {
    var body = files[req.url]; if (!body) { res.writeHead(404); return res.end(); }
    var m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); var a = m ? +m[1] : 0; var b = m && m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
    var chunk = body.slice(a, b + 1);
    res.writeHead(206, { 'content-length': chunk.length, 'content-range': 'bytes ' + a + '-' + b + '/' + body.length, 'accept-ranges': 'bytes', 'content-type': 'video/x-matroska' });
    res.end(chunk);
});
function finish(err) { if (err) console.error(err && err.stack || err); upstream.close(function () { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(err ? 1 : 0); }); }
function stream(tee, src, cb) {
    http.get({ host: '127.0.0.1', port: tee.PORT, path: '/s/' + encodeURIComponent(src), headers: { Range: 'bytes=0-' } }, function (res) {
        var n = 0; res.on('data', function (c) { n += c.length; }); res.on('end', function () { cb(null, n); });
    }).on('error', cb);
}
upstream.listen(0, '127.0.0.1', function () {
    process.env.ASS_TEE_PORT = String(24000 + (process.pid % 9000));
    var tee = require('../service/ass-tee');
    var base = 'http://127.0.0.1:' + upstream.address().port;
    stream(tee, base + '/pgs.mkv', function (err, n) {
        if (err) return finish(err);
        var deadline = Date.now() + 3000;
        (function waitReady() {
            var st = tee.status(base + '/pgs.mkv');
            if (!st.ready) { if (Date.now() > deadline) return finish(new Error('pgs bootstrap never ready: ' + JSON.stringify(st))); return setTimeout(waitReady, 20); }
            try {
                assert.equal(n, files['/pgs.mkv'].length, 'player received the whole file');
                assert.equal(st.textSubs, false, 'PGS-only file reports no text subs');
                assert.deepEqual(st.tracks, [], 'no extractable tracks');
                // the first connection may have demuxed a little before bootstrap finished; a second one must not demux at all
                var before = st.demuxedBytes;
                stream(tee, base + '/pgs.mkv', function (err2, n2) {
                    if (err2) return finish(err2);
                    var st2 = tee.status(base + '/pgs.mkv');
                    try {
                        assert.equal(n2, files['/pgs.mkv'].length);
                        assert.equal(st2.demuxedBytes, before, 'no bytes demuxed once the session knows there are no text subs');
                        assert.ok(st2.passthroughBytes >= files['/pgs.mkv'].length, 'bytes were passed through instead');
                    } catch (e) { return finish(e); }
                    // control: an ASS file must still be demuxed
                    stream(tee, base + '/ass.mkv', function (err3) {
                        if (err3) return finish(err3);
                        var d2 = Date.now() + 3000;
                        (function waitAss() {
                            var sa = tee.status(base + '/ass.mkv');
                            if (!sa.ready) { if (Date.now() > d2) return finish(new Error('ass bootstrap never ready')); return setTimeout(waitAss, 20); }
                            try {
                                assert.equal(sa.textSubs, true); assert.equal(sa.tracks.length, 1, 'one ASS track');
                                assert.ok(sa.demuxedBytes > 0, 'ASS file is demuxed');
                            } catch (e) { return finish(e); }
                            console.log('no-text-subs passthrough: PGS demuxed=' + st2.demuxedBytes + ' passthrough=' + st2.passthroughBytes + ' | ASS demuxed=' + sa.demuxedBytes);
                            finish();
                        })();
                    });
                });
            } catch (e) { finish(e); }
        })();
    });
});
