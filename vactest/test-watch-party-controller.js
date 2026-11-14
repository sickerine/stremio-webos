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
    emit(name, event) { (this.listeners[name] || []).forEach(listener => listener(event)); }
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
const frames = [];
let nowMs = 1_700_000_000_000;
const sandbox = {
    Date: { now: () => nowMs },
    requestAnimationFrame(callback) { frames.push(callback); },
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
            jassub: {},                                  // rAF loop alive (the clock only ticks with a renderer)
            _seeking: false,
            clock: { now() { return 12.5; }, running: true }
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
assert.ok(Number.isFinite(first.state.sampledAtMs), 'TV captures the timestamp before sending');
assert.strictEqual(first.state.positionSeconds, 12.5, 'bridge uses existing stabilized media clock while it is running');
// A frozen clock (after a seek, a stall, or with no subtitle renderer) must NOT be
// reported: viewers would see a TV that never advances. Fall back to the player's time.
sandbox.window.__assCtl.clock.running = false;
socket.sent.length = 0;
video.emit('seeked');
assert.strictEqual(socket.sent.length, 1, 'seeked publishes a sample');
assert.strictEqual(socket.sent[0].state.positionSeconds, video.currentTime, 'frozen clock -> player currentTime');
sandbox.window.__assCtl.clock.running = true;
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
assert.strictEqual(socket.sent.length, 3, 'waiting is explicit state; network stalled alone does not mean playback stopped');
assert.strictEqual(socket.sent[2].state.buffering, true);
assert.strictEqual(socket.sent[2].state.event, 'waiting');
video.emit('playing');
assert.strictEqual(socket.sent[3].state.buffering, false);
assert.strictEqual(socket.sent[3].state.event, 'playing');

sandbox.window.__assCtl = null;
intervals[0]();
const transientIdle = timeouts.find(timer => timer.delay === 1500 && !timer.cancelled);
assert.ok(transientIdle, 'leaving the player schedules an idle transition');
sandbox.window.__assCtl = { video, clock: { now() { return 12.5; } } };
intervals[0]();
assert.strictEqual(transientIdle.cancelled, true, 'a fast player replacement cancels idle');
transientIdle.callback();
assert.strictEqual(socket.sent.length, 4, 'a cancelled idle transition sends nothing');

sandbox.window.__assCtl = null;
intervals[0]();
const confirmedIdle = timeouts.findLast(timer => timer.delay === 1500 && !timer.cancelled);
confirmedIdle.callback();
assert.strictEqual(socket.sent.length, 5, 'leaving playback publishes idle after the grace period');
assert.strictEqual(socket.sent[4].type, 'idle');
assert.strictEqual(socket.sent[4].sessionId, first.state.sessionId);
assert.ok(Number.isFinite(socket.sent[4].sampledAtMs));
assert.ok(socket.sent[4].sequence > socket.sent[3].state.sequence);
socket.emit('message', { data: JSON.stringify({ type: 'clock-ping', t: 123 }) });
assert.strictEqual(socket.sent[5].type, 'clock-pong');
assert.strictEqual(socket.sent[5].t, 123);
assert.ok(Number.isFinite(socket.sent[5].tvMs));

// webOS refreshes currentTime five times a second. Without the subtitle clock, a change
// is reported with the moment the frame loop saw it, so a sample is not up to 200 ms stale.
video.paused = false;
sandbox.window.__assCtl = { video, clock: { running: false } };
intervals[0]();
frames.shift()();
video.currentTime = 20; nowMs += 16; frames.shift()();
nowMs += 150;
const fresh = sandbox.window.__watchParty.state();
assert.strictEqual(fresh.positionSeconds, 20);
assert.strictEqual(fresh.sampledAtMs, nowMs - 150 - 8, 'timestamp of the change, between the two frames around it');
nowMs += 400;
assert.strictEqual(sandbox.window.__watchParty.state().sampledAtMs, nowMs, 'no change for half a second: stalled, so read as of now');
// A seek sets currentTime before playback resumes there: that value is not advancing yet.
video.currentTime = 300; nowMs += 120; video.emit('seeked');
nowMs += 16; frames.shift()();   // the frame loop sees 300 for the first time only now
nowMs += 100;
assert.strictEqual(sandbox.window.__watchParty.state().sampledAtMs, nowMs, 'after a seek the position is read as of now until it moves again');

console.log('watch-party controller tests passed');
