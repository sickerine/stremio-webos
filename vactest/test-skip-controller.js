const assert = require('node:assert/strict');
const test = require('node:test');

const { createController } = require('../service/overlay/skip-controller');

function response(body) {
    return { ok: true, json: async () => body };
}

test('loads timestamps for the exact selected media URL', async () => {
    let requested;
    const values = [];
    const controller = createController({
        getMedia: () => ({ url: 'https://cdn.example/Episode 4.mkv' }),
        fetch: async url => {
            requested = url;
            return response({ intro: { from: 62000, to: 152986 }, outro: null });
        },
        delay: async () => {},
    });

    await controller.load({ id: 'kitsu:49444:4', durationMs: 1440000 }, value => values.push(value));

    assert.deepEqual(values, [null, { intro: { from: 62000, to: 152986 }, outro: null }]);
    assert.match(requested, /id=kitsu%3A49444%3A4/);
    assert.match(requested, /u=https%3A%2F%2Fcdn\.example%2FEpisode%204\.mkv/);
});

test('a late previous episode response cannot overwrite the current episode', async () => {
    const pending = [];
    const applied = [];
    const controller = createController({
        getMedia: () => ({ url: 'https://cdn.example/current.mkv' }),
        fetch: url => new Promise(resolve => pending.push({ url, resolve })),
        delay: async () => {},
    });

    const first = controller.load({ id: 'kitsu:1:1', durationMs: 1000000 }, value => applied.push(['one', value]));
    await Promise.resolve();
    const second = controller.load({ id: 'kitsu:1:2', durationMs: 1000000 }, value => applied.push(['two', value]));
    await Promise.resolve();
    pending[1].resolve(response({ intro: { from: 10000, to: 90000 }, outro: null }));
    await second;
    pending[0].resolve(response({ intro: { from: 20000, to: 100000 }, outro: null }));
    await first;

    assert.deepEqual(applied, [
        ['one', null],
        ['two', null],
        ['two', { intro: { from: 10000, to: 90000 }, outro: null }],
    ]);
});

test('waits briefly for the player media URL instead of querying the wrong stream', async () => {
    let attempts = 0;
    let fetches = 0;
    const controller = createController({
        getMedia: () => (++attempts < 3
            ? { url: 'https://cdn.example/previous.mkv' }
            : { url: 'https://cdn.example/ready.mkv' }),
        fetch: async () => { fetches++; return response({ intro: null, outro: null }); },
        delay: async () => {},
    });

    await controller.load({
        id: 'kitsu:1:3',
        durationMs: 1000000,
        expectedMediaUrl: 'https://cdn.example/ready.mkv',
    }, () => {});
    assert.equal(attempts, 3);
    assert.equal(fetches, 1);
});

test('matches a transcoded player URL to its original selected media', async () => {
    let requested;
    const controller = createController({
        getMedia: () => ({ url: 'https://cdn.example/original.mkv' }),
        fetch: async url => { requested = url; return response({ intro: null, outro: null }); },
        delay: async () => {},
    });

    await controller.load({
        id: 'kitsu:1:4',
        durationMs: 1000000,
        expectedMediaUrl: 'http://127.0.0.1:11470/hls/master.m3u8?mediaURL=' +
            encodeURIComponent('https://cdn.example/original.mkv'),
    }, () => {});
    assert.match(requested, /u=https%3A%2F%2Fcdn\.example%2Foriginal\.mkv/);
});
