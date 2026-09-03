const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../service/overlay/watch-party-controller.js'), 'utf8');

class FakeVideo {
    constructor() {
        this.currentTime = 12;
        this.duration = 1440;
        this.paused = false;
        this.playbackRate = 1;
        this.readyState = 4;
        this.listeners = {};
    }
    addEventListener(name, listener) { (this.listeners[name] = this.listeners[name] || []).push(listener); }
    removeEventListener(name, listener) {
        this.listeners[name] = (this.listeners[name] || []).filter(candidate => candidate !== listener);
    }
    emit(name) { (this.listeners[name] || []).forEach(listener => listener()); }
}

class FakeWebSocket {
    static OPEN = 1;
    static instances = [];
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.listeners = {};
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }
    addEventListener(name, listener) { (this.listeners[name] = this.listeners[name] || []).push(listener); }
    emit(name) { (this.listeners[name] || []).forEach(listener => listener()); }
    open() { this.readyState = FakeWebSocket.OPEN; this.emit('open'); }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.readyState = 3; }
}

const video = new FakeVideo();
const storage = {
    watchPartyEnabled: '1',
    watchPartyUrl: 'ws://192.168.1.47:3211/ws'
};
const intervals = [];
const timeouts = [];
const sandbox = {
    Date,
    WebSocket: FakeWebSocket,
    clearInterval() {},
    clearTimeout(id) { if (timeouts[id - 1]) timeouts[id - 1].cancelled = true; },
    console,
    document: { title: 'Stremio Patched' },
    location: { hash: '#/player/a/b/c/d/e/kitsu%3A49444%3A3' },
    localStorage: { getItem(key) { return storage[key] == null ? null : storage[key]; } },
    performance: { now() { return 1_000; } },
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    setTimeout(callback, delay) {
        timeouts.push({ callback, delay, cancelled: false });
        return timeouts.length;
    },
    window: {
        __assCtl: {
            video,
            clock: { now() { return 12.5; } }
        },
        __stremioCurrentMedia() {
            return { url: 'https://media.example/bleach-3.mkv', teed: true };
        }
    }
};
sandbox.window.window = sandbox.window;
vm.runInNewContext(source, sandbox);

assert.strictEqual(FakeWebSocket.instances.length, 1, 'bridge connects once');
const socket = FakeWebSocket.instances[0];
assert.strictEqual(socket.url, 'ws://192.168.1.47:3211/ws?role=tv');
socket.open();

assert.strictEqual(socket.sent.length, 1, 'opening the socket publishes current state');
const first = socket.sent[0];
assert.strictEqual(first.type, 'state');
assert.strictEqual(first.state.positionSeconds, 12.5, 'bridge uses existing stabilized media clock');
assert.strictEqual(first.state.mediaUrl, 'https://media.example/bleach-3.mkv');
assert.strictEqual(first.state.episodeId, 'kitsu:49444:3');
assert.strictEqual(first.state.paused, false);

video.paused = true;
video.emit('pause');
assert.strictEqual(socket.sent.length, 2, 'player events publish immediately');
assert.strictEqual(socket.sent[1].state.paused, true);
assert.ok(socket.sent[1].state.sequence > first.state.sequence);

video.emit('waiting');
video.emit('stalled');
assert.strictEqual(socket.sent.length, 2, 'buffering noise never generates sync commands');

sandbox.window.__assCtl = null;
intervals[0]();
const transientIdle = timeouts.find(timer => timer.delay === 1500 && !timer.cancelled);
assert.ok(transientIdle, 'leaving the player schedules an idle transition');
sandbox.window.__assCtl = { video, clock: { now() { return 12.5; } } };
intervals[0]();
assert.strictEqual(transientIdle.cancelled, true, 'a fast player replacement cancels idle');
transientIdle.callback();
assert.strictEqual(socket.sent.length, 2, 'a cancelled idle transition sends nothing');

sandbox.window.__assCtl = null;
intervals[0]();
const confirmedIdle = timeouts.findLast(timer => timer.delay === 1500 && !timer.cancelled);
confirmedIdle.callback();
assert.strictEqual(socket.sent.length, 3, 'leaving playback publishes idle after the grace period');
assert.deepStrictEqual(socket.sent[2], { type: 'idle', sessionId: first.state.sessionId });

console.log('watch-party controller tests passed');
