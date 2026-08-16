(function (root) {
    'use strict';

    function hasStreams(response) {
        if (!response || !response.ok) return Promise.resolve(false);
        return response.clone().json().then(function (payload) {
            return !!(payload && Array.isArray(payload.streams) && payload.streams.length);
        }).catch(function () { return false; });
    }

    function expectedIdentity(options) {
        var sid = /^kitsu:\d+:(\d+)$/.exec((options || {}).sid || '');
        var local = sid ? +sid[1] : null;
        var pairs = ((options || {}).ids || []).map(function (id) {
            var match = /^tt\d+:(\d+):(\d+)$/.exec(id || '');
            return match ? { season: +match[1], episode: +match[2] } : null;
        }).filter(Boolean);
        var episodes = {};
        if (local != null) episodes[local] = true;
        pairs.forEach(function (pair) { episodes[pair.episode] = true; });
        return { local: local, pairs: pairs, episodes: episodes };
    }

    function releaseMarker(stream) {
        var hints = (stream || {}).behaviorHints || {};
        var text = String(hints.filename || stream.title || stream.name || '').split('\n')[0];
        var exact = /\bS(?:eason)?[ ._-]*0*(\d{1,2})[ ._-]*E(?:p(?:isode)?)?[ ._-]*0*(\d{1,4})\b/i.exec(text);
        if (exact) return { season: +exact[1], first: +exact[2], last: +exact[2] };
        var seasonMatch = /\bS(?:eason)?[ ._-]*0*(\d{1,2})\b/i.exec(text);
        var roman = /\s(II|III|IV|V)\s*-\s*0*(\d{1,4})\b/.exec(text);
        if (roman) return {
            season: { II: 2, III: 3, IV: 4, V: 5 }[roman[1]],
            first: +roman[2], last: +roman[2],
        };
        var range = /\s-\s*0*(\d{1,4})\s*(?:-|~)\s*0*(\d{1,4})\b/.exec(text);
        if (range) return {
            season: seasonMatch ? +seasonMatch[1] : null,
            first: +range[1], last: +range[2],
        };
        var episode = /(?:\s-\s*|\bEp(?:isode)?[ ._-]*|\bE)0*(\d{1,4})\b/i.exec(text);
        return episode ? {
            season: seasonMatch ? +seasonMatch[1] : null,
            first: +episode[1], last: +episode[1],
        } : null;
    }

    function matchesIdentity(stream, expected) {
        var marker = releaseMarker(stream);
        if (!marker || expected.local == null) return true;
        var episodeMatches = false;
        Object.keys(expected.episodes).some(function (episode) {
            episode = +episode;
            if (episode >= marker.first && episode <= marker.last) episodeMatches = true;
            return episodeMatches;
        });
        if (!episodeMatches) return false;
        if (marker.season == null || marker.season === 1) return true;
        return expected.pairs.some(function (pair) {
            return pair.season === marker.season &&
                pair.episode >= marker.first && pair.episode <= marker.last;
        });
    }

    function sanitizeAnimeStreamResponse(response, options) {
        if (!response || !response.ok) return Promise.resolve(response);
        var expected = expectedIdentity(options);
        return response.clone().json().then(function (payload) {
            if (!payload || !Array.isArray(payload.streams)) return response;
            var streams = payload.streams.filter(function (stream) {
                return matchesIdentity(stream, expected);
            });
            if (streams.length === payload.streams.length) return response;
            var body = {};
            Object.keys(payload).forEach(function (key) { body[key] = payload[key]; });
            body.streams = streams;
            return new Response(JSON.stringify(body), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        }).catch(function () { return response; });
    }

    function retryAnimeStreamAliases(options) {
        var fetcher = options.fetcher;
        var seen = {};
        var ids = (options.ids || []).filter(function (id) {
            if (!/^tt\d+:\d+:\d+$/.test(id || '') || seen[id]) return false;
            seen[id] = true;
            return true;
        });
        if (!ids.length) return Promise.resolve(options.direct);
        // Every alias describes the same verified episode, so start them
        // together and return the first populated response. A slow or failed
        // standalone lookup must not block an already-populated franchise one.
        return new Promise(function (resolve) {
            var pending = ids.length;
            var settled = false;
            function empty() {
                pending--;
                if (!pending && !settled) {
                    settled = true;
                    resolve(options.direct);
                }
            }
            ids.forEach(function (id) {
                var url = options.prefix + encodeURIComponent(id) + options.suffix;
                fetcher(url, options.init).then(function (response) {
                    return sanitizeAnimeStreamResponse(response, {
                        sid: options.sid,
                        ids: ids,
                    });
                }).then(function (response) {
                    return hasStreams(response).then(function (found) {
                        if (found && !settled) {
                            settled = true;
                            resolve(response);
                        } else if (!found) empty();
                    });
                }).catch(empty);
            });
        });
    }

    root.__retryAnimeStreamAliases = retryAnimeStreamAliases;
    root.__sanitizeAnimeStreamResponse = sanitizeAnimeStreamResponse;
})(typeof self !== 'undefined' ? self : window);
