(function () {
    'use strict';

    var globalObject = typeof self !== 'undefined' ? self : window;
    if (!globalObject.fetch || globalObject.__streamRefreshInstalled) return;
    globalObject.__streamRefreshInstalled = true;

    var nativeFetch = globalObject.fetch.bind(globalObject);
    var active = null;
    var ACTIVE_MS = 15000;
    var STREAM_PATH = /\/stream\/(?:series|movie|anime)\//i;
    var channel = null;
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            channel = new BroadcastChannel('stremio-stream-refresh');
            channel.onmessage = function (event) {
                var data = event && event.data;
                if (!data || !data.nonce || !data.expiresAt) return;
                active = { nonce: String(data.nonce), expiresAt: +data.expiresAt };
            };
        }
    } catch (_) {}

    function begin() {
        active = {
            nonce: Date.now().toString(36),
            expiresAt: Date.now() + ACTIVE_MS
        };
        try { if (channel) channel.postMessage(active); } catch (_) {}
        return active.nonce;
    }

    function requestUrl(input) {
        return typeof input === 'string' ? input : input && input.url;
    }

    function shouldRefresh(url) {
        return active && Date.now() < active.expiresAt && STREAM_PATH.test(String(url || ''));
    }

    function refreshUrl(url) {
        var parsed = new URL(url, globalObject.location.href);
        parsed.searchParams.set('refresh', active.nonce);
        return parsed.toString();
    }

    globalObject.fetch = function (input, init) {
        var url = requestUrl(input);
        if (!shouldRefresh(url)) return nativeFetch(input, init);

        var nextInit = {};
        var key;
        for (key in (init || {})) nextInit[key] = init[key];
        nextInit.cache = 'no-store';

        var nextUrl = refreshUrl(url);
        var nextInput = typeof Request !== 'undefined' && input instanceof Request
            ? new Request(nextUrl, input)
            : nextUrl;
        return nativeFetch(nextInput, nextInit);
    };

    globalObject.StreamRefresh = {
        begin: begin,
        reload: async function (unload, load) {
            begin();
            await unload();
            await load();
        }
    };
})();
