const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadController() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'service', 'overlay',
        'stream-refresh.js'), 'utf8');
    const calls = [];
    const originalFetch = async (input, init) => {
        calls.push({ input: String(input), init });
        return { ok: true };
    };
    const window = {
        fetch: originalFetch,
        location: { href: 'http://127.0.0.1:8080/' },
    };
    vm.runInNewContext(source, {
        window,
        URL,
        Headers,
        Request,
        Date,
        Promise,
        setTimeout,
    }, { filename: 'stream-refresh.js' });
    return { window, calls };
}

test('refresh controller bypasses client caches for addon stream requests only', async () => {
    const { window, calls } = loadController();

    await window.fetch('https://addon.test/meta/series/kitsu%3A1.json');
    window.StreamRefresh.begin();
    await window.fetch('https://addon.test/stream/series/kitsu%3A1%3A2.json');

    assert.equal(calls[0].input, 'https://addon.test/meta/series/kitsu%3A1.json');
    const refreshed = new URL(calls[1].input);
    assert.ok(refreshed.searchParams.get('refresh'));
    assert.equal(calls[1].init.cache, 'no-store');
});

test('refresh controller unloads the old core resource before loading it again', async () => {
    const { window } = loadController();
    const events = [];

    await window.StreamRefresh.reload(
        async () => events.push('unload'),
        async () => events.push('load'),
    );

    assert.deepEqual(events, ['unload', 'load']);
});

test('page refresh generation reaches the worker that fetches addon resources', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'service', 'overlay',
        'stream-refresh.js'), 'utf8');
    const channels = [];
    class BroadcastChannel {
        constructor() { channels.push(this); }
        postMessage(data) {
            channels.forEach(channel => {
                if (channel !== this && channel.onmessage) channel.onmessage({ data });
            });
        }
    }
    function boot(kind, calls) {
        const globalObject = {
            fetch: async (input, init) => {
                calls.push({ input: String(input), init });
                return { ok: true };
            },
            location: { href: 'http://127.0.0.1:8080/' },
        };
        const context = {
            URL, Headers, Request, Date, Promise, setTimeout, BroadcastChannel,
            [kind]: globalObject,
        };
        vm.runInNewContext(source, context, { filename: `stream-refresh-${kind}.js` });
        return globalObject;
    }

    const page = boot('window', []);
    const workerCalls = [];
    const worker = boot('self', workerCalls);
    page.StreamRefresh.begin();
    await worker.fetch('https://addon.test/stream/series/kitsu%3A1%3A2.json');

    assert.ok(new URL(workerCalls[0].input).searchParams.get('refresh'));
});

test('details patch puts Refresh beside the stream filters and wires the reload action', () => {
    const patch = fs.readFileSync(path.join(__dirname, '..', 'patches',
        'zzzzzzzzzzz-stream-refresh.patch'), 'utf8');

    assert.match(patch, /label: "Refresh"/);
    assert.match(patch, /onRefresh/);
    assert.match(patch, /StreamRefresh\.reload/);
    assert.match(patch, /g\.unload/);
    assert.match(patch, /__refresh[\s\S]*y\(null\), y\(0\)/);
    const launch = fs.readFileSync(path.join(__dirname, '..', 'service', 'launch.js'), 'utf8');
    assert.match(launch, /stream-refresh\.js/);
});
