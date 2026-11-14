(function (root, factory) {
    'use strict';
    var exported = factory();
    if (typeof module === 'object' && module.exports) module.exports = exported;
    if (root && root.document) root.AnimeSkip = exported.createController({
        fetch: root.fetch.bind(root),
        getMedia: function () {
            return typeof root.__stremioCurrentMedia === 'function' ? root.__stremioCurrentMedia() : null;
        },
        delay: function (milliseconds) {
            return new Promise(function (resolve) { root.setTimeout(resolve, milliseconds); });
        },
    });
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    function createController(dependencies) {
        var fetcher = dependencies.fetch;
        var getMedia = dependencies.getMedia;
        var delay = dependencies.delay;
        var generation = 0;
        var activeMediaKey = null;
        var suppressedSkip = null;
        var floating = null;        // { key, since }: the button currently shown without the controls
        var dismissedKey = null;
        var floatTimer = null;
        var FLOAT_MS = 10000;
        var MAX_MEDIA_ATTEMPTS = 120;

        function unwrapMediaUrl(url) {
            var match = /[?&]mediaURL=([^&]+)/.exec(url || '');
            if (!match) return url;
            try { return decodeURIComponent(match[1]); } catch (error) { return url; }
        }

        function currentMedia(attempt, expectedUrl) {
            var media = getMedia();
            expectedUrl = unwrapMediaUrl(expectedUrl);
            if (media && /^https?:\/\//.test(media.url || '') &&
                (!expectedUrl || media.url === expectedUrl)) return Promise.resolve(media.url);
            if (attempt >= MAX_MEDIA_ATTEMPTS) return Promise.resolve(null);
            return delay(250).then(function () { return currentMedia(attempt + 1, expectedUrl); });
        }

        function request(input) {
            return currentMedia(0, input.expectedMediaUrl).then(function (mediaUrl) {
                if (!mediaUrl) return null;
                var query = 'id=' + encodeURIComponent(input.id) +
                    '&durationMs=' + encodeURIComponent(Math.round(input.durationMs)) +
                    '&u=' + encodeURIComponent(mediaUrl);
                return fetcher('http://127.0.0.1:8081/skip-times?' + query).then(function (response) {
                    return response.ok ? response.json() : null;
                });
            }).catch(function () { return null; });
        }

        function mediaKey(input) {
            if (!input) return null;
            return JSON.stringify([
                input.id || null,
                Number(input.durationMs) || null,
                unwrapMediaUrl(input.expectedMediaUrl) || null,
            ]);
        }

        function selectMedia(input) {
            var nextKey = mediaKey(input);
            if (nextKey === activeMediaKey) return;
            activeMediaKey = nextKey;
            suppressedSkip = null;
            floating = null;
            dismissedKey = null;
        }

        function load(input, apply) {
            var ticket = ++generation;
            selectMedia(input);
            apply(null);
            if (!input || !/^(?:kitsu:\d+|tt\d+:\d+):\d+$/.test(input.id || '') ||
                !isFinite(Number(input.durationMs)) || Number(input.durationMs) <= 0)
                return Promise.resolve(null);
            return request(input).then(function (result) {
                if (ticket !== generation) return null;
                var normalized = result && (result.intro || result.outro != null) ? result : null;
                apply(normalized);
                return normalized;
            });
        }

        function clear(apply) {
            generation++;
            activeMediaKey = null;
            suppressedSkip = null;
            if (typeof apply === 'function') apply(null);
        }

        function markSkipped(type, end) {
            end = Number(end);
            suppressedSkip = (type === 'intro' || type === 'outro') && isFinite(end)
                ? { type: type, end: end }
                : null;
        }

        function shouldShow(type, time, value) {
            if (!value || value.from == null || value.to == null) return false;
            time = Number(time);
            var from = Number(value && value.from);
            var to = Number(value && value.to);
            if (!isFinite(time) || !isFinite(from) || !isFinite(to)) return false;

            if (suppressedSkip !== null) {
                if (time > suppressedSkip.end) suppressedSkip = null;
                else if (type === suppressedSkip.type && to === suppressedSkip.end) return false;
            }

            return time >= from && time <= to;
        }

        function segmentType(time, data, allowOutro) {
            if (data && shouldShow('intro', time, data.intro)) return 'intro';
            if (allowOutro && data && shouldShow('outro', time, data.outro)) return 'outro';
            return null;
        }

        function segmentKey(type, data) {
            return type + ':' + (data && data[type] ? data[type].to : '');
        }

        // With the controls open the button stays for the whole segment. Alone on
        // screen it holds the remote, so it shows for FLOAT_MS and can be dismissed.
        // onFloatEnd runs when the time is up: playback time stops while paused, so
        // nothing else would ask again.
        function visibleType(time, data, allowOutro, controlsVisible, now, onFloatEnd) {
            clearTimeout(floatTimer);
            var type = segmentType(time, data, allowOutro);
            if (!type) {
                floating = null;
                dismissedKey = null;
                return null;
            }
            if (controlsVisible) return type;
            var key = segmentKey(type, data);
            if (key === dismissedKey) return null;
            now = now == null ? Date.now() : now;
            if (!floating || floating.key !== key) floating = { key: key, since: now };
            var left = FLOAT_MS - (now - floating.since);
            if (left <= 0) return null;
            if (onFloatEnd) floatTimer = setTimeout(onFloatEnd, left);
            return type;
        }

        function dismiss(type, data) {
            dismissedKey = segmentKey(type, data);
        }

        // What a remote key does while the button is alone on screen.
        function floatingKey(keyCode) {
            if (keyCode === 461 || keyCode === 8 || keyCode === 27 || keyCode === 40) return 'dismiss';   // Back, Down
            if (keyCode === 37 || keyCode === 38 || keyCode === 39) return 'controls';                    // Left, Up, Right
            return null;
        }

        function skipTarget(type, data) {
            var value = data && data[type];
            if (!value || value.to == null) return null;
            var target = Number(value && value.to);
            return isFinite(target) ? target : null;
        }

        function shouldHandlePlayerOk(controlsVisible, menuVisible, nextVisible, skipVisible) {
            return !controlsVisible && !menuVisible && !nextVisible && !skipVisible;
        }

        function shouldHandlePlayerActivity(controlsVisible, skipVisible) {
            return controlsVisible || !skipVisible;
        }

        return {
            load: load,
            clear: clear,
            markSkipped: markSkipped,
            visibleType: visibleType,
            dismiss: dismiss,
            floatingKey: floatingKey,
            skipTarget: skipTarget,
            shouldHandlePlayerOk: shouldHandlePlayerOk,
            shouldHandlePlayerActivity: shouldHandlePlayerActivity,
        };
    }

    return { createController: createController };
});
