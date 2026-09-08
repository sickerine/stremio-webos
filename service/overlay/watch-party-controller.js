(function () {
    'use strict';
    if (window.__watchParty) return;

    function setting(key, fallback) {
        try {
            var value = localStorage.getItem(key);
            return value == null ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    var enabled = setting('watchPartyEnabled', '0') === '1';
    var serverUrl = setting('watchPartyUrl', '');
    var socket = null;
    var video = null;
    var buffering = false;
    var mediaUrl = null;
    var sessionId = null;
    var sourceRevision = 0;
    var sequence = 0;
    var wasSettling = false;
    var reconnectTimer = 0;
    var idleTimer = 0;
    var idleGeneration = 0;
    var lastHeartbeat = 0;
    var listeners = {};

    function episodeId() {
        var hash = location.hash || '';
        try { hash = decodeURIComponent(hash); } catch (error) {}
        var match = hash.match(/kitsu:\d+:\d+/) || hash.match(/(?:tt\d+|tmdb:\d+):\d+:\d+/);
        return match ? match[0] : '';
    }

    function currentMedia() {
        try {
            var media = window.__stremioCurrentMedia && window.__stremioCurrentMedia();
            return media && /^https?:\/\//i.test(media.url || '') ? media.url : null;
        } catch (error) {
            return null;
        }
    }

    function positionSeconds() {
        if (!video) return 0;
        if (!video.paused) {
            try {
                // The ASS clock is only trustworthy while it is RUNNING and its rAF loop is
                // alive (it only ticks when a subtitle renderer exists). Otherwise a seek
                // freezes it for good and viewers would see a TV that never advances.
                var controller = window.__assCtl;
                var position = controller && controller.video === video && controller.clock
                    && controller.clock.running && controller.jassub && !controller._seeking
                    ? controller.clock.now(performance.now())
                    : NaN;
                if (isFinite(position) && position >= 0) return position;
            } catch (error) {}
        }
        return isFinite(video.currentTime) && video.currentTime >= 0 ? video.currentTime : 0;
    }

    function state(event) {
        return {
            sampledAtMs: Date.now(),
            event: event || "heartbeat",
            buffering: Boolean(buffering || (video && video.seeking)),
            sessionId: sessionId,
            sequence: ++sequence,
            sourceRevision: sourceRevision,
            positionSeconds: positionSeconds(),
            paused: Boolean(!video || video.paused || video.ended),
            playbackRate: video && isFinite(video.playbackRate) && video.playbackRate > 0 ? video.playbackRate : 1,
            durationSeconds: video && isFinite(video.duration) ? video.duration : null,
            mediaUrl: mediaUrl,
            episodeId: episodeId(),
            title: episodeId() || document.title || ''
        };
    }

    function publish(event) {
        if (!sessionId || !socket || socket.readyState !== WebSocket.OPEN) return;
        try { socket.send(JSON.stringify({ type: 'state', state: state(typeof event === "string" ? event : "heartbeat") })); } catch (error) {}
    }

    function publishIdle() {
        if (!sessionId || !socket || socket.readyState !== WebSocket.OPEN) return;
        var stoppedSessionId = sessionId;
        sessionId = null;
        mediaUrl = null;
        try { socket.send(JSON.stringify({ type: 'idle', sessionId: stoppedSessionId, sampledAtMs: Date.now(), sequence: ++sequence })); } catch (error) {}
    }

    function cancelIdle() {
        idleGeneration += 1;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = 0;
    }

    function scheduleIdle() {
        if (!sessionId || idleTimer) return;
        var generation = ++idleGeneration;
        idleTimer = setTimeout(function () {
            if (generation !== idleGeneration) return;
            idleTimer = 0;
            publishIdle();
        }, 1500);
    }

    function playerEvent(name) {
        return function () {
            if (name === 'waiting') buffering = true;
            if (name === 'playing' || name === 'seeked') buffering = false;
            publish(name);
            if (name === 'ended') scheduleIdle();
        };
    }

    function detach() {
        if (!video) return;
        Object.keys(listeners).forEach(function (name) {
            try { video.removeEventListener(name, listeners[name]); } catch (error) {}
        });
        listeners = {};
        video = null;
    }

    function attach(nextVideo) {
        if (nextVideo === video) return;
        detach();
        video = nextVideo;
        buffering = false;
        if (!video) return;
        ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'waiting', 'playing', 'ended']
            .forEach(function (name) {
                listeners[name] = playerEvent(name);
                video.addEventListener(name, listeners[name]);
            });
    }

    function updateSource(nextUrl) {
        if (nextUrl === mediaUrl) return;
        mediaUrl = nextUrl;
        sourceRevision += 1;
        sequence = 0;
        sessionId = Date.now().toString(36) + '-' + sourceRevision.toString(36);
        publish("source");
    }

    function tick() {
        var controller = window.__assCtl;
        var nextVideo = controller && controller.video && controller.video.isConnected !== false
            ? controller.video
            : null;
        var nextUrl = currentMedia();
        var active = nextVideo && !nextVideo.ended && nextUrl;
        attach(nextVideo);
        if (!active) {
            scheduleIdle();
            return;
        }
        cancelIdle();
        updateSource(nextUrl);
        // After a seek the ASS clock is frozen until webOS currentTime stops bouncing;
        // the moment it re-locks, send the accurate position so viewers land on it.
        var settling = Boolean(controller && controller._seeking);
        if (wasSettling && !settling) publish("seeked");
        wasSettling = settling;
        var now = Date.now();
        if (sessionId && now - lastHeartbeat >= 500) {
            lastHeartbeat = now;
            publish();
        }
    }

    function connect() {
        if (!enabled || !serverUrl) return;
        clearTimeout(reconnectTimer);
        var separator = serverUrl.indexOf('?') >= 0 ? '&' : '?';
        try { socket = new WebSocket(serverUrl + separator + 'role=tv'); }
        catch (error) { reconnectTimer = setTimeout(connect, 2000); return; }
        socket.addEventListener('open', publish);
        socket.addEventListener('message', function (event) {
            var msg; try { msg = JSON.parse(event.data); } catch (error) { return; }
            if (msg.type === 'clock-ping') socket.send(JSON.stringify({ type: 'clock-pong', t: msg.t, tvMs: Date.now() }));
        });
        socket.addEventListener('close', function () {
            socket = null;
            reconnectTimer = setTimeout(connect, 2000);
        });
        socket.addEventListener('error', function () {
            try { socket.close(); } catch (error) {}
        });
    }

    tick();
    setInterval(tick, 500);
    connect();

    window.__watchParty = {
        publish: publish,
        state: state,
        status: function () {
            return {
                connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
                enabled: enabled,
                mediaUrl: mediaUrl,
                serverUrl: serverUrl,
                sessionId: sessionId
            };
        }
    };
})();
