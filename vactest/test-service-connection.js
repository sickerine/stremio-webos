var assert = require('node:assert/strict');
var fs = require('fs');
var vm = require('vm');
var bridges = [], timers = new Map(), handlers = {}, nextTimer = 0;
function Bridge() { bridges.push(this); }
Bridge.prototype.call = function (uri, payload) { this.uri = uri; this.payload = JSON.parse(payload); };
Bridge.prototype.cancel = function () { this.cancelled = true; };
var window = { PalmServiceBridge: Bridge, addEventListener: function (name, cb) { handlers[name] = cb; } };
vm.runInNewContext(fs.readFileSync(require.resolve('../app/service-connection.js'), 'utf8'), {
    window: window,
    setTimeout: function (cb, delay) { var id = ++nextTimer; timers.set(id, { cb: cb, delay: delay }); return id; },
    clearTimeout: function (id) { timers.delete(id); },
});
function fire(delay) {
    var entry = Array.from(timers).find(function (pair) { return pair[1].delay === delay; });
    assert.ok(entry, 'scheduled callback exists at ' + delay);
    timers.delete(entry[0]); entry[1].cb();
}
var ready = 0;
window.connectStremioService(function () { ready++; });
assert.equal(bridges[0].payload.subscribe, true, 'open page holds a service subscription');
fire(20000); // Unresponsive old service.
assert.equal(bridges[0].cancelled, true);
fire(1000);
bridges[0].onservicecallback('{"ready":true}');
assert.equal(ready, 0, 'late reply from abandoned connection is ignored');
bridges[1].onservicecallback('{"returnValue":true,"ready":true}');
assert.equal(ready, 1, 'replacement service is accepted');
fire(10000);
assert.equal(bridges[1].cancelled, true, 'renewal releases the old subscription');
bridges[2].onservicecallback('{"returnValue":false}');
fire(1000);
bridges[3].onservicecallback('invalid JSON');
fire(1000);
bridges[4].onservicecallback('{"ready":true}');
assert.equal(ready, 2, 'errors and malformed replies do not prevent recovery');
handlers.pagehide();
assert.equal(bridges[4].cancelled, true, 'closing the page releases the service');
assert.equal(timers.size, 0, 'closed pages stop reconnecting');
console.log('PASSED subscription lifetime, timeout recovery, stale replies and page closure');
