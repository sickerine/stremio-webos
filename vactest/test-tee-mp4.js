var assert = require('node:assert/strict');
var http = require('http');
var M = require('../service/mkv-subs');

// The MP4 header from the failing stream, followed by arbitrary media bytes.
var media = Buffer.alloc(2 * 1024 * 1024, 0x55);
Buffer.from('000000206674797069736f6d0000020069736f6d6462793169736f326d703431', 'hex').copy(media);
var demux = new M.MkvSubDemux({});
for (var off = 0; off < media.length;) {
    // A split signature must not depend on HTTP chunk boundaries.
    var end = off === 0 ? 1 : Math.min(off + 16384, media.length);
    demux.pushAt(off, media.slice(off, end));
    off = end;
}
assert.equal(demux._sPending.length, 0, 'non-MKV bytes are not retained');
assert.equal(demux.isMatroska, false, 'MP4 is rejected by the MKV parser');

var bootstrapHits = 0;
var cdn = http.createServer(function (req, res) {
    var m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    var start = m ? +m[1] : 0;
    var end = m && m[2] ? Math.min(+m[2], media.length - 1) : media.length - 1;
    if (m && +m[2] > media.length) bootstrapHits++;
    res.writeHead(206, { 'content-length': end - start + 1,
        'content-range': 'bytes ' + start + '-' + end + '/' + media.length,
        'content-type': 'application/octet-stream' });
    res.end(media.slice(start, end + 1));
});
function finish(err) {
    if (err) console.error(err.stack || err);
    cdn.close();
    process.exit(err ? 1 : 0);
}
cdn.listen(0, '127.0.0.1', async function () {
    process.env.ASS_TEE_PORT = String(26000 + process.pid % 10000);
    var tee = require('../service/ass-tee');
    // No filename or MIME hint: detect the actual bytes.
    var source = 'http://127.0.0.1:' + cdn.address().port + '/opaque';
    try {
        for (var range of ['bytes=0-', 'bytes=131072-262143']) {
            var response = await fetch('http://127.0.0.1:' + tee.PORT + '/s/' + encodeURIComponent(source), { headers: { Range: range } });
            var bytes = Buffer.from(await response.arrayBuffer());
            assert.equal(response.status, 206);
            assert.deepEqual(bytes, range === 'bytes=0-' ? media : media.slice(131072, 262144), 'player bytes are unchanged');
        }
        var state = tee.status(source);
        assert.equal(state.ready, true, 'MP4 bootstrap finishes without retries');
        assert.equal(state.textSubs, false, 'MP4 bypasses the MKV subtitle parser');
        assert.equal(bootstrapHits, 1);
        assert.ok(state.passthroughBytes >= 131072, 'later ranges bypass demuxing');
        console.log('PASSED MP4 signature, bounded retention and byte-for-byte range passthrough');
        finish();
    } catch (err) { finish(err); }
});
