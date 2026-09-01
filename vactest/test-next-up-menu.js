const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const menu = require('../service/overlay/next-up-menu.js');

const card = {
    id: 'kitsu:49444',
    nextUp: { videoId: 'kitsu:49444:6' },
};
const metadata = {
    watched: true,
    videos: [
        { id: 'kitsu:49444:6', released: '2026-08-29T14:00:00.000Z', watched: true },
        { id: 'kitsu:49444:7', released: '2026-09-05T14:00:00.000Z', watched: false },
    ],
};

test('Next Up menu reads and toggles the displayed episode, not the whole show', () => {
    const calls = [];
    let refreshes = 0;
    const model = {
        setWatched(value) { calls.push(['series', value]); },
        toggleVideoWatched(video) { calls.push(['episode', video.id, video.watched]); },
    };

    assert.equal(menu.watched(card, metadata), true);
    menu.toggle(card, metadata, model, () => { refreshes++; });
    assert.deepEqual(calls, [['episode', 'kitsu:49444:6', true]]);
    assert.equal(refreshes, 1, 'Next Up was not told to refresh after the watched action');
});

test('ordinary cards keep the existing series-level watched action', () => {
    const calls = [];
    const model = {
        setWatched(value) { calls.push(value); },
        toggleVideoWatched() { throw new Error('episode action should not run'); },
    };

    assert.equal(menu.watched({ id: 'kitsu:49444' }, metadata), true);
    menu.toggle({ id: 'kitsu:49444' }, metadata, model);
    assert.deepEqual(calls, [false]);
});

test('generated UI patch exposes Details on Next Up cards and uses the menu helper', () => {
    const patch = fs.readFileSync(path.join(__dirname, '..', 'patches',
        'zzzz-next-up-menu.patch'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'service', 'index.html'), 'utf8');

    assert.match(patch, /NextUpMenu\.watched/);
    assert.match(patch, /NextUpMenu\.toggle/);
    assert.match(patch, /NextUpMenu\.hasDetails/);
    const homePatch = fs.readFileSync(path.join(__dirname, '..', 'patches',
        'zzz-home-anime.patch'), 'utf8');
    assert.match(homePatch, /nextUp && m\.nextUp\.videoId/);
    assert.ok(html.indexOf('/next-up-menu.js') < html.indexOf('main.js'));
});
