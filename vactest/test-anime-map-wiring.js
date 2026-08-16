const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('the Kitsu stream interceptor sanitizes the direct response before accepting it', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'service', 'launch.js'), 'utf8');

    assert.match(source, /__sanitizeAnimeStreamResponse/);
    assert.match(source, /sid:sid,ids:ids/);
    assert.ok(source.indexOf('__sanitizeAnimeStreamResponse') < source.indexOf('hasStreams(cleanDirect)'),
        'the direct response was accepted before season and episode validation');
});
