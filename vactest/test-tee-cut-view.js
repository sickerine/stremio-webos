// The player is served the file without its Attachments element (LG's player spends about
// a second per 5 MB of attached fonts before the first frame), while the subtitle side
// still gets the fonts and the dialogue.
var assert = require('node:assert/strict');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');
var G = require('./mkv-gen.js');
var Cut = require('../service/mkv-cut.js');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-tee-cut-'));
var mediaPath = path.join(tmp, 'episode.mkv');
G.build({
    path: mediaPath, durSec: 4, bitrateBps: 2e6, index: true,
    events: [{ start: 0.25, end: 1.5, text: 'First line', style: 'Default' }, { start: 2.5, end: 3.5, text: 'Later line', style: 'Default' }],
    attachments: [{ name: 'big.ttf', mime: 'font/ttf', data: Buffer.alloc(3 * 1024 * 1024, 9) }],
});
var media = fs.readFileSync(mediaPath);
var plan = Cut.plan(media);
// What the player must be served: the rewritten head, then the rest with its Cues rewritten.
var rest = Buffer.from(media.slice(plan.end));
Cut.cues(rest, plan, plan.cuesAt - plan.end);
var view = Buffer.concat([plan.head, rest]);
var requested = [];

function cleanup() { try { fs.unlinkSync(mediaPath); fs.rmdirSync(tmp); } catch (e) {} }
var cdn = http.createServer(function (req, res) {
    var match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    var start = match ? +match[1] : 0;
    var end = match && match[2] ? Math.min(+match[2], media.length - 1) : media.length - 1;
    requested.push([start, end]);
    res.writeHead(206, { 'content-length': end - start + 1, 'content-range': 'bytes ' + start + '-' + end + '/' + media.length, 'accept-ranges': 'bytes', 'content-type': 'video/x-matroska' });
    if (start !== 0) return res.end(media.slice(start, end + 1));
    // The read from the top is the subtitle side's: its fonts arrive slowly, as from a real CDN.
    res.write(media.slice(0, plan.start + 65536));
    setTimeout(function () { res.end(media.slice(plan.start + 65536, end + 1)); }, 800);
});
function fail(error) { console.error(error && error.stack || error); cleanup(); cdn.close(function () { process.exit(1); }); }

cdn.listen(0, '127.0.0.1', function () {
    process.env.ASS_TEE_PORT = String(27000 + (process.pid % 9000));
    var tee = require('../service/ass-tee');
    var source = 'http://127.0.0.1:' + cdn.address().port + '/episode.mkv';
    function get(range, done) {
        http.get({ host: '127.0.0.1', port: tee.PORT, path: '/s/' + encodeURIComponent(source), headers: range ? { range: range } : {} }, function (res) {
            var parts = []; res.on('data', function (c) { parts.push(c); });
            res.on('end', function () { done(res, Buffer.concat(parts)); });
        }).on('error', fail);
    }
    var from = plan.start + 300000;                                    // a resume: the player's offsets are the view's
    get('bytes=' + from + '-', function (res2, body2) {
        try {
            assert.ok(plan && plan.cut > 3 * 1024 * 1024, 'the fixture has an Attachments element worth cutting');
            assert.equal(res2.statusCode, 206);
            assert.equal(res2.headers['content-range'], 'bytes ' + from + '-' + (media.length - plan.cut - 1) + '/' + (media.length - plan.cut));
            assert.ok(body2.equals(view.slice(from)), 'a range is served from the matching real offset, its Cues rewritten');
            var resumed = tee.status(source);
            assert.equal(resumed.ready, false, 'the fonts are still coming in');
            assert.equal(resumed.tracks.length, 1, 'the track list does not wait for the fonts');
            assert.match(tee.trackText(source, 0), /Later line/, 'nor does the dialogue of a stream that starts mid-file');
        } catch (error) { return fail(error); }
        get(null, function (res, body) {
            try {
                assert.equal(res.statusCode, 200);
                assert.equal(+res.headers['content-length'], view.length, 'the length is the view\'s');
                assert.ok(body.equals(view), 'the player gets the file without the Attachments element, positions rewritten');
                assert.ok(!view.equals(Buffer.concat([media.slice(0, plan.start), media.slice(plan.end)])), 'the fixture has positions to rewrite');
                assert.ok(!requested.some(function (r) { return r[0] > 0 && r[0] < plan.end; }), 'the font bytes are not fetched a second time for the player');
                var early = tee.status(source);
                assert.equal(early.ready, false, 'the fonts are still coming in');
                assert.ok(early.tracks[0].events >= 2, 'the dialogue from the top does not wait for them either');
            } catch (error) { return fail(error); }
            var deadline = Date.now() + 2000;
            (function poll() {
                var status = tee.status(source);
                if (status.ready && status.tracks[0] && status.tracks[0].events >= 2) {
                    try {
                        assert.deepEqual(status.fonts, ['big.ttf'], 'the subtitle side still has the font');
                        assert.equal(tee.fontData(source, 'big.ttf').length, 3 * 1024 * 1024);
                        var text = tee.trackText(source, 0);
                        assert.ok(/First line/.test(text) && /Later line/.test(text), 'dialogue is read from the player\'s streams');
                        console.log('PASSED the player gets the attachment-free view; fonts and dialogue still reach the subtitle side');
                        cleanup();
                        return cdn.close(function () { process.exit(0); });
                    } catch (error) { return fail(error); }
                }
                if (Date.now() >= deadline) return fail(new Error('subtitle side never became ready: ' + JSON.stringify(status).slice(0, 300)));
                setTimeout(poll, 20);
            })();
        });
    });
});
