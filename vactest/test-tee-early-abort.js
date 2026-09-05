// The player aborts a probe connection before the tee's upstream has even
// connected. The tee must notice (close arrived before the upstream callback),
// destroy the upstream instead of streaming into the dead response, and leave
// no live connection behind. This was the "200 Mbps with nothing playing" orphan.
var assert = require('node:assert/strict');
var fs = require('fs'); var http = require('http'); var net = require('net'); var os = require('os'); var path = require('path');
var mkv = require('./mkv-gen');
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-tee-abort-'));
var file = path.join(tmp, 'v.mkv'); mkv.build({ path: file, durSec: 20, bitrateBps: 3000000, seed: 9 }); var body = fs.readFileSync(file);
var upstreamBytesSent = 0, upstreamOpen = 0, upstreamClosed = 0;
var upstream = http.createServer(function (req, res) {
    var m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); var a = m ? +m[1] : 0; var b = m && m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
    upstreamOpen++;
    // delay the headers so the client can abort in the window before the tee's upstream callback runs
    setTimeout(function () {
        res.writeHead(206, { 'content-length': b - a + 1, 'content-range': 'bytes ' + a + '-' + b + '/' + body.length, 'accept-ranges': 'bytes', 'content-type': 'video/x-matroska' });
        var pos = a; var t = setInterval(function () { if (pos > b) { clearInterval(t); return res.end(); } var e = Math.min(pos + 65536, b + 1); res.write(body.slice(pos, e)); upstreamBytesSent += e - pos; pos = e; }, 5);
        res.on('close', function () { clearInterval(t); upstreamClosed++; });
    }, 300);
});
function finish(err) { if (err) console.error(err && err.stack || err); upstream.close(function () { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(err ? 1 : 0); }); }
upstream.listen(0, '127.0.0.1', function () {
    process.env.ASS_TEE_PORT = String(26000 + (process.pid % 9000));
    var tee = require('../service/ass-tee');
    var src = 'http://127.0.0.1:' + upstream.address().port + '/v.mkv';
    // bootstrap first so the session is ready (as on the TV), using a tiny complete request
    http.get({ host: '127.0.0.1', port: tee.PORT, path: '/s/' + encodeURIComponent(src), headers: { Range: 'bytes=0-1023' } }, function (r) { r.resume(); r.on('end', function () {
        var baseline = upstreamOpen;
        // raw socket: send a ranged GET, then slam the connection shut before the upstream (300ms) answers
        var sock = net.connect(tee.PORT, '127.0.0.1', function () {
            sock.write('GET /s/' + encodeURIComponent(src) + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-\r\n\r\n');
            setTimeout(function () { sock.destroy(); }, 60);
        });
        sock.on('error', function () {});
        setTimeout(function () {
            var sentAt1 = upstreamBytesSent;
            setTimeout(function () {
                try {
                    assert.equal(upstreamOpen, baseline + 1, 'the aborted request did open one upstream');
                    assert.ok(upstreamClosed >= 1, 'the upstream was closed after the client vanished');
                    assert.equal(tee.liveCount(), 0, 'no live tee connection remains');
                    assert.equal(tee.status(src).liveConns, 0, 'session shows no live connections');
                    assert.ok(upstreamBytesSent - sentAt1 < 4 * 65536, 'no sustained streaming into a dead response (' + (upstreamBytesSent - sentAt1) + ' bytes in 700ms)');
                } catch (e) { return finish(e); }
                console.log('early abort: upstream closed, liveConns 0, bytes after abort ' + upstreamBytesSent);
                finish();
            }, 700);
        }, 900);
    }); }).on('error', finish);
});
