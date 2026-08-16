const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('the generated-player patch feeds the existing skip state and follows control visibility', () => {
    const patch = fs.readFileSync(path.join(__dirname, '..', 'patches', 'zzzzzzzzzz-skip-times.patch'), 'utf8');
    assert.match(patch, /window\.AnimeSkip\.load/);
    assert.match(patch, /expectedMediaUrl/);
    assert.match(patch, /__skipData\(\)/);
    assert.match(patch, /get controlsVisible\(\)/);
    assert.match(patch, /autoFocus/);
    assert.match(patch, /with-controls/);
});

test('the browser controller is loaded before the player runtime', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'service', 'index.html'), 'utf8');
    assert.ok(html.indexOf('/skip-controller.js') < html.indexOf('runtime.js'));
});
