// The built player must (1) load the audio picker, (2) build its native audio list
// from more than just "addtrack" (loadedmetadata + poll), (3) use AudioPick for the
// language preference and (4) re-pick once server labels arrive. Regression guard for
// the "no audio menu / hearing the commentary" pair seen on the TV.
var assert = require('node:assert/strict');
var fs = require('fs'); var path = require('path');
var www = path.join(__dirname, '../service/www');
var chunk = fs.readFileSync(path.join(www, 'video.chunk.js'), 'utf8');
var html = fs.readFileSync(path.join(__dirname, '../service/index.html'), 'utf8');
assert.ok(/<script src="\/audio-pick\.js"><\/script>/.test(html), 'index.html loads /audio-pick.js');
assert.ok(fs.existsSync(path.join(www, 'audio-pick.js')), 'audio-pick.js ships in www');
assert.ok(chunk.indexOf('A.__nativeAudioInit = function()') > 0, 'native audio init is a reusable routine on the element');
assert.ok(/addEventListener\("addtrack", function\(\) \{ setTimeout\(A\.__nativeAudioInit, 100\); \}\)/.test(chunk), 'addtrack calls the init');
assert.ok(/A\.onloadedmetadata = function\(\) \{\s*try \{ A\.__nativeAudioInit\(\); \}/.test(chunk), 'loadedmetadata calls the init');
assert.ok(chunk.indexOf('function __audioPoll(n)') > 0 && chunk.indexOf('})(20);') > 0, 'short poll as a safety net');
assert.ok(chunk.indexOf('window.AudioPick.pick(') > 0, 'preference goes through AudioPick');
assert.ok(chunk.indexOf('window.AudioPick.repick(') > 0 && chunk.indexOf('__switchNativeAudio(__alt)') > 0, 'labels arriving can move us off a commentary track');
assert.ok(/\(T \|\| \[\]\)\.length !== A\.audioTracks\.length/.test(chunk), 'init is idempotent (only when the mirrored list is stale)');
console.log('native audio wiring: all checks passed');
