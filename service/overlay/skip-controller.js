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
        var suppressedIntroEnd = null;
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
            suppressedIntroEnd = null;
        }

        function load(input, apply) {
            var ticket = ++generation;
            selectMedia(input);
            apply(null);
            if (!input || !/^kitsu:\d+:\d+$/.test(input.id || '') ||
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
            suppressedIntroEnd = null;
            if (typeof apply === 'function') apply(null);
        }

        function markIntroSkipped(end) {
            end = Number(end);
            suppressedIntroEnd = isFinite(end) ? end : null;
        }

        function shouldShowIntro(time, from, to) {
            time = Number(time);
            from = Number(from);
            to = Number(to);
            if (!isFinite(time) || !isFinite(from) || !isFinite(to)) return false;

            if (suppressedIntroEnd !== null) {
                if (time > suppressedIntroEnd) suppressedIntroEnd = null;
                else if (to === suppressedIntroEnd) return false;
            }

            return time >= from && time <= to;
        }

        function shouldHandlePlayerOk(controlsVisible, menuVisible, nextVisible, skipVisible) {
            return !controlsVisible && !menuVisible && !nextVisible && !skipVisible;
        }

        return {
            load: load,
            clear: clear,
            markIntroSkipped: markIntroSkipped,
            shouldShowIntro: shouldShowIntro,
            shouldHandlePlayerOk: shouldHandlePlayerOk,
        };
    }

    return { createController: createController };
});
