(function (root) {
    'use strict';
    root.connectStremioService = function (ready, failed) {
        if (typeof root.PalmServiceBridge !== 'function') return function () {};
        var bridge = null, timer = null, closed = false;
        function cancel() {
            clearTimeout(timer);
            var old = bridge;
            bridge = null;
            if (old) { try { old.cancel(); } catch (e) {} }
        }
        function connect() {
            if (closed) return;
            cancel();
            var current = bridge = new root.PalmServiceBridge();
            function retry() {
                if (current !== bridge || closed) return;
                cancel();
                timer = setTimeout(connect, 1000);
                if (failed) failed();
            }
            current.onservicecallback = function (response) {
                if (current !== bridge || closed) return;
                var data;
                try { data = JSON.parse(response); } catch (e) { retry(); return; }
                if (!data.ready || data.returnValue === false) { retry(); return; }
                clearTimeout(timer);
                // Renew the subscription so a lost cancellation callback cannot
                // leave the page disconnected after a service crash.
                timer = setTimeout(connect, 10000);
                if (ready) ready();
            };
            timer = setTimeout(retry, 20000);
            try { current.call('luna://io.stremio.patched.server/start', '{"subscribe":true}'); }
            catch (e) { retry(); }
        }
        function close() { closed = true; cancel(); }
        root.addEventListener('pagehide', close);
        connect();
        return close;
    };
})(window);
