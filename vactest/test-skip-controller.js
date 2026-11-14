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

test('a successful skip stays dismissed when the media seek settles before the boundary', () => {
    const controller = createController({
        getMedia: () => null,
        fetch: async () => response(null),
        delay: async () => {},
    });

    const data = { intro: { from: 62000, to: 152000 }, outro: null };
    assert.equal(controller.visibleType(83000, data, true), 'intro');

    controller.markSkipped('intro', 152000);

    assert.equal(controller.visibleType(152000, data, true), null);
    assert.equal(controller.visibleType(148000, data, true), null);
    assert.equal(controller.visibleType(152001, data, true), null);
    assert.equal(controller.visibleType(83000, data, true), 'intro');
});

test('shows an ending without intro data and seeks to its finite end', async () => {
    const applied = [];
    const endingOnly = { intro: null, outro: { from: 1260000, to: 1350000 } };
    const controller = createController({
        getMedia: () => ({ url: 'https://cdn.example/current.mkv' }),
        fetch: async () => response(endingOnly),
        delay: async () => {},
    });

    await controller.load({ id: 'kitsu:1:3', durationMs: 1440000 }, value => applied.push(value));

    assert.deepEqual(applied, [null, endingOnly]);
    assert.equal(controller.visibleType(1260000, endingOnly, true), 'outro');
    assert.equal(controller.visibleType(1260000, endingOnly, false), null);
    assert.equal(controller.skipTarget('outro', endingOnly), 1350000);
    assert.equal(controller.skipTarget('intro', endingOnly), null);
});

test('ending suppression handles keyframe rollback and resets after its boundary', () => {
    const controller = createController({
        getMedia: () => null,
        fetch: async () => response(null),
        delay: async () => {},
    });
    const data = { intro: null, outro: { from: 1260000, to: 1350000 } };

    controller.markSkipped('outro', 1350000);
    assert.equal(controller.visibleType(1349000, data, true), null);
    assert.equal(controller.visibleType(1350001, data, true), null);
    assert.equal(controller.visibleType(1260000, data, true), 'outro');
});

test('the global player OK handler does not run while the skip action owns focus', () => {
    const controller = createController({
        getMedia: () => null,
        fetch: async () => response(null),
        delay: async () => {},
    });

    assert.equal(controller.shouldHandlePlayerOk(false, false, false, false), true);
    assert.equal(controller.shouldHandlePlayerOk(false, false, false, true), false);
    assert.equal(controller.shouldHandlePlayerOk(true, false, false, false), false);
    assert.equal(controller.shouldHandlePlayerOk(false, true, false, false), false);
    assert.equal(controller.shouldHandlePlayerOk(false, false, true, false), false);
});

test('remote activity cannot reveal controls before a focused skip action receives the press', () => {
    const controller = createController({
        getMedia: () => null,
        fetch: async () => response(null),
        delay: async () => {},
    });

    assert.equal(controller.shouldHandlePlayerActivity(false, true), false);
    assert.equal(controller.shouldHandlePlayerActivity(false, false), true);
    assert.equal(controller.shouldHandlePlayerActivity(true, true), true);
});

test('skip suppression survives duplicate loads but resets for a different episode', async () => {
    const controller = createController({
        getMedia: () => ({ url: 'https://cdn.example/current.mkv' }),
        fetch: async () => response({ intro: { from: 62000, to: 152000 }, outro: null }),
        delay: async () => {},
    });
    const firstEpisode = { id: 'kitsu:1:1', durationMs: 1000000 };

    await controller.load(firstEpisode, () => {});
    controller.markSkipped('intro', 152000);
    await controller.load(firstEpisode, () => {});
    assert.equal(controller.visibleType(83000, { intro: { from: 62000, to: 152000 } }, true), null);

    await controller.load({ id: 'kitsu:1:2', durationMs: 1000000 }, () => {});
    assert.equal(controller.visibleType(83000, { intro: { from: 62000, to: 152000 } }, true), 'intro');
});

test('alone on screen the skip action lets go of the remote after ten seconds; with the controls open it stays', () => {
    const controller = createController({
        getMedia: () => null,
        fetch: async () => response(null),
        delay: async () => {},
    });
    const data = { intro: { from: 0, to: 90000 }, outro: null };

    assert.equal(controller.visibleType(1000, data, true, false, 0), 'intro');
    assert.equal(controller.visibleType(9000, data, true, false, 9999), 'intro');
    assert.equal(controller.visibleType(10000, data, true, false, 10000), null);
    assert.equal(controller.visibleType(40000, data, true, true, 40000), 'intro');    // player view open
    assert.equal(controller.visibleType(41000, data, true, false, 41000), null);
    // Rewinding into the intro after it ended starts over.
    assert.equal(controller.visibleType(95000, data, true, false, 95000), null);
    assert.equal(controller.visibleType(5000, data, true, false, 100000), 'intro');
});

test('Back and Down dismiss the floating skip action; Left, Up and Right open the controls', () => {
    const controller = createController({
        getMedia: () => null,
        fetch: async () => response(null),
        delay: async () => {},
    });
    const data = { intro: { from: 0, to: 90000 }, outro: null };

    assert.deepEqual([461, 40].map(controller.floatingKey), ['dismiss', 'dismiss']);
    assert.deepEqual([37, 38, 39].map(controller.floatingKey), ['controls', 'controls', 'controls']);
    assert.equal(controller.floatingKey(13), null);                                   // OK belongs to the action

    assert.equal(controller.visibleType(1000, data, true, false, 0), 'intro');
    controller.dismiss('intro', data);
    assert.equal(controller.visibleType(2000, data, true, false, 1000), null);
    assert.equal(controller.visibleType(3000, data, true, true, 2000), 'intro');      // still there in the player view
});

test('an IMDb episode gets skip data too', async () => {
    let requested;
    const controller = createController({
        getMedia: () => ({ url: 'https://cdn.example/dexter.mkv' }),
        fetch: async url => { requested = url; return response({ intro: { from: 1000, to: 21586 }, outro: null }); },
        delay: async () => {},
    });

    assert.deepEqual(await controller.load({ id: 'tt0773262:1:1', durationMs: 3190000 }, () => {}),
        { intro: { from: 1000, to: 21586 }, outro: null });
    assert.match(requested, /id=tt0773262%3A1%3A1/);
});

test('a paused player still lets go: the floating skip action reports when its ten seconds are up', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = createController({
        getMedia: () => null,
        fetch: async () => response(null),
        delay: async () => {},
    });
    const data = { intro: { from: 0, to: 90000 }, outro: null };
    let ended = 0;

    assert.equal(controller.visibleType(1000, data, true, false, 0, () => ended++), 'intro');
    t.mock.timers.tick(9999);
    assert.equal(ended, 0);
    t.mock.timers.tick(1);
    assert.equal(ended, 1);

    // Opening the player view first cancels it.
    assert.equal(controller.visibleType(95000, data, true, false, 20000), null);
    assert.equal(controller.visibleType(1000, data, true, false, 30000, () => ended++), 'intro');
    assert.equal(controller.visibleType(2000, data, true, true, 31000, () => ended++), 'intro');
    t.mock.timers.tick(20000);
    assert.equal(ended, 1);
});
