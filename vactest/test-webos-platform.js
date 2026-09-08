// Run the shipped platform provider and player selector, not a copied UA parser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const www = path.join(__dirname, '../service/www');

function platformFor(userAgent) {
    const factories = {};
    const context = vm.createContext({
        navigator: { userAgent },
        self: { webpackChunkstremio_theater: { push(chunk) { Object.assign(factories, chunk[1]); } } }
    });
    for (const file of ['main.js', 'video.chunk.js']) {
        vm.runInContext(fs.readFileSync(path.join(www, file), 'utf8'), context);
    }
    const exports = {};
    // Only Solid's context/lifecycle plumbing is substituted. Platform decisions
    // and the values supplied by the actual provider run unchanged.
    const requirePlatform = id => id === 9225 ? {
        q6: () => ({ Provider: {} }), Rc: () => {}, a0: (_, props) => props.value
    } : {};
    requirePlatform.d = (target, getters) => {
        for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
    };
    factories[289]({}, exports, requirePlatform);
    const platform = exports.V9({});
    const selector = { exports: {} };
    const wrappers = new Set([8131, 1222, 437]);
    factories[361](selector, {}, id => wrappers.has(id) ? player => player : { id });
    const player = selector.exports({ platform: platform.name, streamingServerURL: 'http://127.0.0.1:8081', stream: { url: 'https://example.test/movie.mkv' } }, {});
    return { platform, player };
}

const ua = chrome => `Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36 WebAppManager`;

test('webOS 26 selects the existing webOS player', () => {
    const { platform, player } = platformFor(ua('132.0.6834.207'));
    assert.equal(platform.name, 'webOS');
    assert.equal(platform.isWebOS, true);
    assert.equal(platform.version, 26);
    assert.equal(player.id, 8803);
});

test('a firmware browser patch does not change the platform', () => {
    assert.equal(platformFor(ua('132.0.9999.1')).player.id, 8803);
});

test('an unknown future webOS browser still selects the webOS player', () => {
    const { platform, player } = platformFor(ua('999.0.0.0'));
    assert.equal(platform.isWebOS, true);
    assert.equal(platform.version, null);
    assert.equal(player.id, 8803);
});

test('desktop Chrome stays on the browser player', () => {
    const { platform, player } = platformFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.207 Safari/537.36');
    assert.equal(platform.name, 'Web');
    assert.equal(platform.isWebOS, false);
    assert.equal(player.id, 8584);
});
