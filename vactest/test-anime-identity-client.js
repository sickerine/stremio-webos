const assert = require('node:assert/strict');
const test = require('node:test');

const { createIdentityClient } = require('../service/anime-identity-client');

test('identity client returns every verified unique IMDb episode alias', async () => {
    let requested;
    const client = createIdentityClient(async request => {
        requested = request;
        return {
            aliases: [
                { id: 'tt14986406:4:4', confidence: 'verified' },
                { id: 'tt0434665:17:44', confidence: 'verified' },
                { id: 'tt0434665:17:44', confidence: 'verified' },
                { id: 'tt0000000:1:1', confidence: 'provisional' },
                { id: 'not-an-episode', confidence: 'verified' },
            ],
        };
    });

    const ids = await client.resolveEpisode('kitsu:49444:4');

    assert.deepEqual(ids, ['tt14986406:4:4', 'tt0434665:17:44']);
    assert.deepEqual(requested, {
        hostname: 'stremio-nyaa.vercel.app',
        path: '/identity/series/kitsu%3A49444%3A4.json',
        method: 'GET',
        headers: { Accept: 'application/json' },
    });
});

test('identity client exposes provider IDs with the verified episode aliases', async () => {
    const client = createIdentityClient(async () => ({
        ids: { kitsu: 49444, myanimelist: 60636, imdb: 'tt0434665' },
        titles: ['BLEACH: Thousand-Year Blood War Part 4'],
        aliases: [
            { id: 'tt14986406:4:4', confidence: 'verified' },
            { id: 'tt0434665:17:44', confidence: 'verified' },
            { id: 'tt0000000:1:1', confidence: 'provisional' },
        ],
    }));

    assert.deepEqual(await client.resolveIdentity('kitsu:49444:4'), {
        ids: { kitsu: 49444, myanimelist: 60636, imdb: 'tt0434665' },
        titles: ['BLEACH: Thousand-Year Blood War Part 4'],
        aliases: [
            { id: 'tt14986406:4:4', confidence: 'verified' },
            { id: 'tt0434665:17:44', confidence: 'verified' },
        ],
    });
});

test('identity client fails closed for malformed input and unavailable mapping data', async () => {
    let calls = 0;
    const client = createIdentityClient(async () => {
        calls++;
        throw new Error('offline');
    });

    assert.deepEqual(await client.resolveEpisode('kitsu:nope:3'), []);
    assert.deepEqual(await client.resolveEpisode('kitsu:49444:3'), []);
    assert.deepEqual(await client.resolveEpisode('kitsu:49444:3'), []);
    assert.equal(calls, 2, 'a transient network failure was pinned in the negative cache');
});

test('identity client caches verified aliases and valid empty responses separately', async () => {
    var time = 1000;
    var calls = 0;
    const client = createIdentityClient(async request => {
        calls++;
        return request.path.includes('49444')
            ? { aliases: [{ id: 'tt0434665:17:44', confidence: 'verified' }] }
            : { aliases: [] };
    }, { now: () => time });

    assert.deepEqual(await client.resolveEpisode('kitsu:49444:4'), ['tt0434665:17:44']);
    assert.deepEqual(await client.resolveEpisode('kitsu:49444:4'), ['tt0434665:17:44']);
    assert.deepEqual(await client.resolveEpisode('kitsu:50000:4'), []);
    assert.deepEqual(await client.resolveEpisode('kitsu:50000:4'), []);
    assert.equal(calls, 2);
});
