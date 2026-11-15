const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('the browser controller is loaded before the player runtime', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'service', 'index.html'), 'utf8');
    assert.ok(html.indexOf('/skip-controller.js') < html.indexOf('runtime.js'));
});
