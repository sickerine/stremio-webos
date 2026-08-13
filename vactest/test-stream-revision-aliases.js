const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadLinker() {
    const source = fs.readFileSync(path.join(
        __dirname, '..', 'service', 'overlay', 'stream-revisions.js',
    ), 'utf8');
    const context = { window: {} };
    vm.runInNewContext(source, context, { filename: 'stream-revisions.js' });
    return context.window.__linkLatestStreamRevisions;
}

function stream(description, player) {
    return { name: 'Torrentio\n1080p', description, deepLinks: { player } };
}

test('combined stream linking is order-stable and reacts when a V2 response arrives late', () => {
    const link = loadLinker();
    const v1 = stream(
        '[SubsPlease] Example Show - 03 (1080p CR WEB-DL AVC)\n👤 500',
        '#/player/v1',
    );
    const v2 = stream(
        '[SubsPlease] Example Show - 03v2 (1080p CR WEB-DL AVC)\n👤 50',
        '#/player/v2',
    );

    const early = link([v1]);
    assert.equal(early[0].deepLinks.player, '#/player/v1');
    assert.equal(early[0].__revisionRedirect, undefined);

    const late = link([v1, v2]);
    assert.deepEqual(Array.from(late, value => value.description), [v1.description, v2.description]);
    assert.equal(late[0].deepLinks.player, '#/player/v2');
    assert.equal(late[0].__revisionRedirect, 'V2');
    assert.equal(late[1].deepLinks.player, '#/player/v2');
});

test('different release lines and conflicting variants never cross-link', () => {
    const link = loadLinker();
    const original = stream('[Group] Show - 03 (1080p CR WEB-DL AVC)\n👤 500', '#/original');
    const candidates = [
        stream('[Other] Show - 03 V2 (1080p CR WEB-DL AVC)', '#/group'),
        stream('[Group] Show - 03 V2 (1080p CR WEB-DL HEVC)', '#/codec'),
        stream('[Group] Show - 03 V2 (720p CR WEB-DL AVC)', '#/resolution'),
        stream('[Group] Show - 03 V2 (1080p DSNP WEB-DL AVC)', '#/platform'),
    ];

    const linked = link([original, ...candidates]);
    assert.equal(linked[0].deepLinks.player, '#/original');
});

test('audio may be added by V2, but a MULTi card does not redirect to a DUAL repack', () => {
    const link = loadLinker();
    const trix = stream('[Trix] MARRIAGETOXIN S01 (Batch) [WEBRip 1080p AV1 Opus]', '#/trix-v1');
    const trixV2 = stream('[Trix] MARRIAGETOXIN S01 v2 (Batch) [WEBRip 1080p AV1 Opus] [Dual Audio]', '#/trix-v2');
    const multi = stream('[ToonsHub] Clevatess S02E03 MULTi 1080p CR WEB-DL H.264', '#/multi');
    const dualRepack = stream('[ToonsHub] Clevatess S02E03 REPACK 1080p CR WEB-DL DUAL H.264', '#/dual-repack');

    const linked = link([trix, trixV2, multi, dualRepack]);
    assert.equal(linked[0].deepLinks.player, '#/trix-v2');
    assert.equal(linked[2].deepLinks.player, '#/multi');
});

test('an addon-provided redirect remains marked without replacing its player target', () => {
    const link = loadLinker();
    const redirected = stream(
        '[Erai-raws] Show - 03 (1080p CR WEB-DL AVC)\n👤 500\n↗ Plays REPACK',
        '#/already-repacked',
    );

    const [linked] = link([redirected]);
    assert.equal(linked.deepLinks.player, '#/already-repacked');
    assert.equal(linked.__revisionRedirect, 'REPACK');
});

test('scene-style group suffixes link across Torrentio and Nyaa result shapes', () => {
    const link = loadLinker();
    const original = stream(
        'One Piece S01E1173 1080p CR WEB-DL AAC2.0 H.264-VARYG\n👤 10',
        '#/torrentio-v1',
    );
    const repack = {
        name: 'Nyaa\n1080p',
        description: 'One Piece S01E1173 REPACK 1080p CR WEB-DL AAC2.0 H.264-VARYG (Multi-Subs)\n👤 38',
        deepLinks: { player: '#/nyaa-repack' },
    };

    const linked = link([original, repack]);
    assert.equal(linked[0].deepLinks.player, '#/nyaa-repack');
    assert.equal(linked[0].__revisionRedirect, 'REPACK');
});
