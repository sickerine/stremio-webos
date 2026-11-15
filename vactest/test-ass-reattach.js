// Attaching again on a controller that is already rendering (the last fonts arrived, or
// the viewer switched to an external subtitle) must leave one render loop, one size timer
// and one set of listeners, and detach must remove them all. A second loop costs the TV
// a render pass per frame for the rest of the episode.
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var listeners = [], intervals = {}, frames = {}, nextId = 0;
function target(extra) {
    return Object.assign({
        addEventListener: function (type, fn) { listeners.push([this, type, fn]); },
        removeEventListener: function (type, fn) { var self = this; listeners = listeners.filter(function (l) { return !(l[0] === self && l[1] === type && l[2] === fn); }); },
    }, extra);
}
var video = target({ readyState: 1, currentSrc: '', isConnected: true, textTracks: [], videoWidth: 1920, videoHeight: 1080, paused: false, currentTime: 0, playbackRate: 1 });
var context = {
    console: console,
    location: { hash: '#/player/episode-1' },
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    document: target({ querySelector: function (selector) { return selector === 'video' ? video : null; }, documentElement: {}, body: {} }),
    performance: { now: function () { return 0; }, getEntriesByType: function () { return []; } },
    setInterval: function (fn) { intervals[++nextId] = fn; return nextId; },
    clearInterval: function (id) { delete intervals[id]; },
    setTimeout: function () { return 0; },
    clearTimeout: function () {},
    requestAnimationFrame: function (fn) { frames[++nextId] = fn; return nextId; },
    cancelAnimationFrame: function (id) { delete frames[id]; },
    fetch: function () { return new Promise(function () {}); },
    JASSUB: function () {
        this._canvasParent = { remove: function () {} };
        this._demandRender = function () {}; this._unbusy = function () {};
        this.addEventListener = function () {}; this.resize = function () {}; this.destroy = function () {};
    },
    URL: URL, unescape: unescape, encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    btoa: function (value) { return Buffer.from(value, 'binary').toString('base64'); },
};
context.window = context;
context.self = context;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../service/overlay/ass-controller.js'), 'utf8'), context, { filename: 'ass-controller.js' });
Object.keys(intervals).forEach(function (id) { intervals[id](); });      // the page's own timers create the controller
var controller = context.__assCtl;
assert.ok(controller, 'a controller owns the video');

function held() { return { listeners: listeners.length, timers: Object.keys(intervals).length, loops: Object.keys(frames).length }; }
var ass = '[Script Info]\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Line\n';
var idle = held();
controller.attach(ass, [], null);
var rendering = held();
assert.ok(rendering.loops > idle.loops && rendering.listeners > idle.listeners, 'attaching starts a render loop and listens to the video');
controller.attach(ass, [], null);
assert.deepEqual(held(), rendering, 'attaching again replaces the first attachment instead of adding to it');
controller.detach();
assert.deepEqual(held(), idle, 'detaching leaves nothing running');
console.log('PASSED a repeated attach keeps one render loop, one timer and one set of listeners');
