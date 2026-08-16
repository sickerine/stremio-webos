const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadHelpers() {
    const source = fs.readFileSync(path.join(
        __dirname, '..', 'service', 'overlay', 'anime-stream-aliases.js',
    ), 'utf8');
    const context = { self: {}, Response };
    vm.runInNewContext(source, context, { filename: 'anime-stream-aliases.js' });
    return {
        retry: context.self.__retryAnimeStreamAliases,
        sanitize: context.self.__sanitizeAnimeStreamResponse,
    };
}

function response(label, streams) {
    return {
        label,
        ok: true,
        clone() { return response(label, streams); },
        async json() { return { streams }; },
    };
}

test('stream fallback tries every verified alias and returns the first one with streams', async () => {
    const { retry } = loadHelpers();
    const calls = [];
    const direct = response('direct', []);
    const fetcher = async url => {
        calls.push(url);
        if (url.includes('tt14986406')) return response('standalone', []);
        if (url.includes('tt0434665')) return response('franchise', [{ title: 'Bleach E44' }]);
        throw new Error('unexpected URL ' + url);
    };

    const result = await retry({
        fetcher,
        init: { headers: { Accept: 'application/json' } },
        direct,
        prefix: 'https://torrentio.test/stream/series/',
        suffix: '.json',
        ids: ['tt14986406:4:4', 'tt0434665:17:44'],
    });

    assert.equal(result.label, 'franchise');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /tt14986406%3A4%3A4/);
    assert.match(calls[1], /tt0434665%3A17%3A44/);
});

test('stream fallback preserves the original response when no alias has streams', async () => {
    const { retry } = loadHelpers();
    const direct = response('direct', []);
    const result = await retry({
        fetcher: async () => response('mapped', []),
        direct,
        prefix: 'https://torrentio.test/stream/series/',
        suffix: '.json',
        ids: ['tt14986406:4:4'],
    });
    assert.equal(result.label, 'direct');
});

test('a slow empty alias cannot block a later alias that already has streams', async () => {
    const { retry } = loadHelpers();
    const calls = [];
    let releaseSlow;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    const pending = retry({
        fetcher: async url => {
            calls.push(url);
            if (url.includes('tt14986406')) return slow;
            return response('franchise', [{ title: 'Bleach E44' }]);
        },
        direct: response('direct', []),
        prefix: 'https://torrentio.test/stream/series/',
        suffix: '.json',
        ids: ['tt14986406:4:4', 'tt0434665:17:44'],
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2, 'aliases were still queried serially');
    const settled = await Promise.race([
        pending,
        new Promise(resolve => setTimeout(() => resolve(null), 20)),
    ]);
    assert.equal(settled && settled.label, 'franchise', 'the completed alias waited on the slow one');
    releaseSlow(response('standalone', []));
});

test('a populated alias with the wrong episode is ignored in favor of a correct alias', async () => {
    const { retry } = loadHelpers();
    const result = await retry({
        fetcher: async url => url.includes('tt14986406')
            ? new Response(JSON.stringify({ streams: [{
                title: '[Wrong] Bleach S04E03',
                behaviorHints: { filename: '[Wrong] Bleach S04E03.mkv' },
            }] }))
            : new Response(JSON.stringify({ streams: [{
                title: '[Right] Bleach S17E44',
                behaviorHints: { filename: '[Right] Bleach S17E44.mkv' },
            }] })),
        direct: response('direct', []),
        sid: 'kitsu:49444:4',
        prefix: 'https://torrentio.test/stream/series/',
        suffix: '.json',
        ids: ['tt14986406:4:4', 'tt0434665:17:44'],
    });

    const payload = await result.json();
    assert.equal(payload.streams.length, 1);
    assert.match(payload.streams[0].title, /Right/);
});

test('direct Kitsu streams with the wrong episode in the filename are removed', async () => {
    const { sanitize } = loadHelpers();
    const direct = new Response(JSON.stringify({ streams: [{
        title: '[DKB] Heroine Maid - S01E0…',
        behaviorHints: { filename: '[DKB] Heroine Maid - S01E08 [1080p].mkv' },
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });

    const cleaned = await sanitize(direct, {
        sid: 'kitsu:49913:1',
        ids: [],
    });

    assert.deepEqual((await cleaned.json()).streams, []);
});

test('direct Kitsu streams from a different season are removed even when the episode matches', async () => {
    const { sanitize } = loadHelpers();
    const direct = new Response(JSON.stringify({ streams: [
        {
            title: '[SubsPlease] Youjo Senki S2 - 01 (1080p)',
            behaviorHints: { filename: '[SubsPlease] Youjo Senki S2 - 01 (1080p).mkv' },
        },
        {
            title: '[Judas] Youjo Senki S01E01 (1080p)',
            behaviorHints: { filename: '[Judas] Youjo Senki S01E01 (1080p).mkv' },
        },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });

    const cleaned = await sanitize(direct, {
        sid: 'kitsu:11794:1',
        ids: ['tt6455986:1:1'],
    });
    const payload = await cleaned.json();

    assert.equal(payload.streams.length, 1);
    assert.match(payload.streams[0].title, /S01E01/);
});
