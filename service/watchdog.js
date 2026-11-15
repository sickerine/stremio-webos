var cp = require('child_process');

// This process must stay separate from the parser's event loop.
function watch(parentPid, timeoutMs, intervalMs) {
    var lastBeat = process.hrtime();
    var lastTick = process.hrtime();
    process.title = 'stremio-watchdog';
    process.on('message', function () { lastBeat = process.hrtime(); });
    process.on('disconnect', function () { process.exit(0); });
    setInterval(function () {
        var tickElapsed = process.hrtime(lastTick);
        lastTick = process.hrtime();
        if (tickElapsed[0] * 1000 + tickElapsed[1] / 1e6 > timeoutMs) {
            // The watchdog was suspended too. Give the parent time to run and
            // drain queued heartbeats before deciding that it is stuck.
            lastBeat = process.hrtime();
            return;
        }
        var elapsed = process.hrtime(lastBeat);
        if (elapsed[0] * 1000 + elapsed[1] / 1e6 <= timeoutMs) return;
        if (process.connected && process.ppid === parentPid) {
            console.error('[watchdog] stopping unresponsive service ' + parentPid);
            try { process.kill(parentPid, 'SIGKILL'); } catch (e) {}
        }
        process.exit(0);
    }, intervalMs);
}

function start(options) {
    options = options || {};
    var timeoutMs = options.timeoutMs || 15000;
    var intervalMs = options.intervalMs || 1000;
    var child = cp.fork(__filename, ['watch', String(process.pid), String(timeoutMs), String(intervalMs)], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [],
    });
    child.on('error', function (err) { console.error('[watchdog] ' + err.message); process.exit(1); });
    var timer = setInterval(function () {
        if (child.connected) child.send('alive', function () {});
    }, intervalMs);
    child.once('exit', function () { clearInterval(timer); process.exit(1); });
    process.once('exit', function () {
        clearInterval(timer);
        try { child.kill(); } catch (e) {}
    });
    return child;
}

if (require.main === module && process.argv[2] === 'watch')
    watch(+process.argv[3], +process.argv[4], +process.argv[5]);

module.exports = { start: start };
