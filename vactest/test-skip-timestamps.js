const assert = require('node:assert/strict');
const test = require('node:test');

const Skip = require('../service/skip-timestamps');

test('reconciles exact-file chapters with a provider by widening matching boundaries', () => {
    const result = Skip.reconcile([
        { type: 'intro', from: 63063, to: 152986, source: 'chapter' },
        { type: 'intro', from: 62000, to: 152000, source: 'introdb' },
    ], 1440000);

    assert.deepEqual(result, { intro: { from: 62000, to: 152986 }, outro: null });
});

test('keeps the skip button available across differing starts when the end agrees', () => {
    const result = Skip.reconcile([
        { type: 'intro', from: 118000, to: 193000, source: 'chapter' },
        { type: 'intro', from: 102667, to: 193792, source: 'aniskip' },
    ], 1440000);

    assert.deepEqual(result.intro, { from: 102667, to: 193792 });
});

test('fails closed when independent intro endpoints disagree', () => {
    const result = Skip.reconcile([
        { type: 'intro', from: 60000, to: 150000, source: 'chapter' },
        { type: 'intro', from: 60000, to: 180000, source: 'aniskip' },
    ], 1440000);

    assert.equal(result.intro, null);
});

test('accepts a plausible named exact-file chapter or a duration-matched API result alone', () => {
    assert.deepEqual(Skip.reconcile([
        { type: 'intro', from: 11000, to: 91000, source: 'chapter' },
    ], 1440000).intro, { from: 11000, to: 91000 });

    assert.deepEqual(Skip.reconcile([
        { type: 'intro', from: 11000, to: 91000, source: 'aniskip', episodeLength: 1441000 },
    ], 1440000).intro, { from: 11000, to: 91000 });
});

test('normalizes chapter, IntroDB, TheIntroDB, and AniSkip payloads', () => {
    assert.deepEqual(Skip.fromChapters([
        { start_time: '63.063', end_time: '152.986', tags: { title: 'Opening' } },
        { start_time: '1330', end_time: '1420', tags: { title: 'ED' } },
        { start_time: '0', end_time: '5', tags: { title: 'Chapter 1' } },
    ]), [
        { type: 'intro', from: 63063, to: 152986, source: 'chapter' },
        { type: 'outro', from: 1330000, to: 1420000, source: 'chapter' },
    ]);

    assert.deepEqual(Skip.fromIntroDb({
        intro: { start_ms: 62000, end_ms: 152000 },
        outro: { start_sec: 1330, end_sec: 1420 },
    }), [
        { type: 'intro', from: 62000, to: 152000, source: 'introdb' },
        { type: 'outro', from: 1330000, to: 1420000, source: 'introdb' },
    ]);

    assert.deepEqual(Skip.fromTheIntroDb({
        intro: [{ start_ms: 62000, end_ms: 152000 }],
        credits: [{ start_ms: 1330000, end_ms: null }],
    }), [
        { type: 'intro', from: 62000, to: 152000, source: 'theintrodb' },
        { type: 'outro', from: 1330000, to: null, source: 'theintrodb' },
    ]);

    assert.deepEqual(Skip.fromTheIntroDb({ intro: [{ start_ms: null, end_ms: 90000 }] }), [
        { type: 'intro', from: 0, to: 90000, source: 'theintrodb' },
    ]);

    assert.deepEqual(Skip.fromAniSkip({ found: true, results: [
        { skipType: 'op', interval: { startTime: 62, endTime: 152 }, episodeLength: 1441 },
        { skipType: 'ed', interval: { startTime: 1330, endTime: 1420 }, episodeLength: 1441 },
    ] }), [
        { type: 'intro', from: 62000, to: 152000, source: 'aniskip', episodeLength: 1441000 },
        { type: 'outro', from: 1330000, to: 1420000, source: 'aniskip', episodeLength: 1441000 },
    ]);
});

test('resolves all providers and exact-file chapters for one selected Kitsu episode', async () => {
    const requested = [];
    const resolver = Skip.createResolver({
        identity: { resolveIdentity: async () => ({
            ids: { myanimelist: 60636 },
            aliases: [{ id: 'tt14986406:4:4' }],
        }) },
        chapters: async url => {
            assert.equal(url, 'https://cdn.example/bleach-e4.mkv');
            return [{ start_time: '63.063', end_time: '152.986', tags: { title: 'OP' } }];
        },
        requestJson: async request => {
            requested.push(request.hostname + request.path);
            if (request.hostname === 'api.introdb.app') return {
                intro: { start_ms: 62000, end_ms: 152000 },
            };
            if (request.hostname === 'api.theintrodb.org') return { error: 'not found' };
            return { found: false, results: [] };
        },
    });

    assert.deepEqual(await resolver.resolve({
        id: 'kitsu:49444:4',
        mediaUrl: 'https://cdn.example/bleach-e4.mkv',
        durationMs: 1440000,
    }), { intro: { from: 62000, to: 152986 }, outro: null });
    assert.equal(requested.length, 3);
    assert.ok(requested.some(x => x.startsWith('api.introdb.app/segments?')));
    assert.ok(requested.some(x => x.startsWith('api.theintrodb.org/v3/media?')));
    assert.ok(requested.some(x => x.startsWith('api.aniskip.com/v2/skip-times/60636/4?')));
});

test('negative results expire quickly and a synchronous chapter-probe failure fails closed', async () => {
    let time = 0;
    let identityCalls = 0;
    const resolver = Skip.createResolver({
        now: () => time,
        identity: { resolveIdentity: async () => {
            identityCalls++;
            return { ids: {}, aliases: [] };
        } },
        chapters: () => { throw new Error('probe unavailable'); },
        requestJson: async () => ({}),
    });
    const input = { id: 'kitsu:1:1', mediaUrl: 'https://cdn.example/e1.mkv', durationMs: 1440000 };

    assert.deepEqual(await resolver.resolve(input), { intro: null, outro: null });
    time += 5 * 60 * 1000;
    assert.deepEqual(await resolver.resolve(input), { intro: null, outro: null });
    assert.equal(identityCalls, 1);
    time += 6 * 60 * 1000;
    assert.deepEqual(await resolver.resolve(input), { intro: null, outro: null });
    assert.equal(identityCalls, 2);
});
