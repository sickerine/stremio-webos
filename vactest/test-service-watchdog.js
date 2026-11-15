var assert = require('node:assert/strict');
var cp = require('child_process');
var path = require('path');
var watchdogPath = process.env.STREMIO_WATCHDOG_PATH || path.resolve(__dirname, '../service/watchdog.js');

if (process.argv[2] === 'fixture') {
    var watchdog = require(watchdogPath).start({ timeoutMs: 500, intervalMs: 50 });
    watchdog.once('spawn', function () {
        process.send({ watchdogPid: watchdog.pid });
        if (process.argv[3] === 'hang') setTimeout(function () { while (true) {} }, 150);
        else if (process.argv[3] === 'lost-watchdog') setTimeout(function () { watchdog.kill(); }, 150);
        else setTimeout(function () { process.exit(0); }, process.argv[3] === 'starved' ? 2400 : 1100);
    });
} else {
    (async function () {
        for (var mode of ['healthy', 'hang', 'starved', 'lost-watchdog']) {
            var child = cp.fork(__filename, ['fixture', mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
            var watcher;
            child.on('message', function (m) {
                watcher = m.watchdogPid;
                if (mode === 'starved') setTimeout(function () {
                    process.kill(watcher, 'SIGSTOP');
                    setTimeout(function () { process.kill(watcher, 'SIGCONT'); }, 800);
                }, 150);
            });
            var timedOut = false;
            var timer = setTimeout(function () { timedOut = true; child.kill('SIGKILL'); }, 5000);
            var result = await new Promise(function (resolve) { child.once('exit', function (code, signal) { resolve({ code: code, signal: signal }); }); });
            clearTimeout(timer);
            assert.ok(watcher, 'watchdog process started');
            assert.equal(timedOut, false, 'fixture finishes without the test killing it');
            assert.deepEqual(result, mode === 'hang' ? { code: null, signal: 'SIGKILL' } : { code: mode === 'lost-watchdog' ? 1 : 0, signal: null });
            var stopped = false;
            for (var i = 0; i < 40; i++) {
                try { process.kill(watcher, 0); } catch (e) { if (e.code === 'ESRCH') { stopped = true; break; } throw e; }
                await new Promise(function (r) { setTimeout(r, 50); });
            }
            if (!stopped) { try { process.kill(watcher, 'SIGKILL'); } catch (e) {} }
            assert.ok(stopped, 'watchdog exits when its parent ends');
        }
        console.log('PASSED healthy and suspended watchdog recovery, blocked service termination, watchdog loss and cleanup');
    })().catch(function (err) { console.error(err); process.exitCode = 1; });
}
