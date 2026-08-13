const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadStreamUi() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'service', 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
        .map(match => match[1]);
    const source = scripts.find(script => script.includes('window.__streamBadges'));
    assert.ok(source, 'stream card UI script was not found');
    const storage = new Map();
    const context = {
        window: { addEventListener() {}, dispatchEvent() {} },
        location: { hash: '#/detail/series/kitsu:1' },
        localStorage: {
            getItem(key) { return storage.get(key) || null; },
            setItem(key, value) { storage.set(key, value); },
        },
        fetch: async () => ({ json: async () => ({ ids: [] }) }),
        setInterval() {},
        setTimeout() {},
        Event: class Event {},
        Set,
        document: {
            createElement() {
                return { className: '', textContent: '' };
            },
        },
    };
    vm.runInNewContext(source, context, { filename: 'service/index.html' });
    return context;
}

function classList() {
    const values = new Set();
    return {
        add(...names) { names.forEach(name => values.add(name)); },
        remove(...names) { names.forEach(name => values.delete(name)); },
        contains(name) { return values.has(name); },
    };
}

test('version releases get a chip and silently redirected cards get a subtle card class', () => {
    const context = loadStreamUi();
    const direct = { name: 'Nyaa\n1080p', description: '[Group] Show - 03v3 (1080p)' };
    const redirected = {
        name: 'Nyaa\n1080p',
        description: '[Group] Show - 03 (1080p)\n👤 500 ⚙️ NyaaSi\n↗ Plays V2',
    };

    assert.deepEqual(Array.from(context.window.__streamBadges(direct)), ['1080p', 'V3']);
    assert.deepEqual(Array.from(context.window.__streamBadges(redirected)), ['1080p', 'V2']);

    const card = { classList: classList() };
    const details = { parentElement: card };
    const badgeRow = {
        parentElement: details,
        classList: classList(),
        textContent: '',
        children: [],
        appendChild(child) { this.children.push(child); },
    };
    context.window.__paintStreamBadges(badgeRow, redirected);

    assert.equal(card.classList.contains('stream-upgraded-card'), true);
    assert.equal(badgeRow.children.at(-1).textContent, 'V2');
    assert.match(badgeRow.children.at(-1).className, /sbag-version/);

    context.window.__paintStreamBadges(badgeRow, direct);
    assert.equal(card.classList.contains('stream-upgraded-card'), false,
        'a genuine V3 release was styled as a silently redirected card');
});
