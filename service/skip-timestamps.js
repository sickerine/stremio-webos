'use strict';

var https = require('https');

var BOUNDARY_TOLERANCE_MS = 5000;
var POSITIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
var NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;

function requestJson(request) {
    return new Promise(function (resolve, reject) {
        var req = https.request(request, function (res) {
            var body = '';
            res.on('data', function (chunk) {
                body += chunk;
                if (body.length > 2e6) req.destroy(new Error('response too large'));
            });
            res.on('end', function () {
                try { resolve(JSON.parse(body)); }
                catch (error) { reject(new Error('invalid JSON from ' + request.hostname)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(12000, function () { req.destroy(new Error('timeout ' + request.hostname)); });
        req.end();
    });
}

function milliseconds(value) {
    if (value == null) return null;
    var number = Number(value);
    return isFinite(number) ? Math.round(number * 1000) : null;
}

function segment(type, from, to, source, episodeLength) {
    var value = { type: type, from: from, to: to, source: source };
    if (episodeLength != null) value.episodeLength = episodeLength;
    return value;
}

function fromChapters(chapters) {
    return (chapters || []).map(function (chapter) {
        var title = String(chapter && chapter.tags && chapter.tags.title || '').trim().toLowerCase();
        var type = /^(?:intro|ncop|op(?:ening)?)(?:\s*[-_:]?\s*\d+)?(?:\s+(?:theme|credits|song))?$/i.test(title)
            ? 'intro'
            : (/^(?:outro|credits|nced|ed|ending)(?:\s*[-_:]?\s*\d+)?(?:\s+(?:theme|credits|song))?$/i.test(title) ||
                /^end credits$/i.test(title) ? 'outro' : null);
        if (!type) return null;
        return segment(type, milliseconds(chapter.start_time), milliseconds(chapter.end_time), 'chapter');
    }).filter(Boolean);
}

function dbTime(value, millisecondsValue) {
    if (millisecondsValue != null && isFinite(Number(millisecondsValue))) return Math.round(Number(millisecondsValue));
    if (value != null && isFinite(Number(value))) return milliseconds(value);
    return null;
}

function fromIntroDb(payload) {
    var result = [];
    [['intro', 'intro'], ['outro', 'outro']].forEach(function (pair) {
        var raw = payload && payload[pair[0]];
        if (!raw) return;
        var from = dbTime(raw.start_sec, raw.start_ms);
        if (pair[1] === 'intro' && from == null) from = 0;
        result.push(segment(pair[1], from,
            dbTime(raw.end_sec, raw.end_ms), 'introdb'));
    });
    return result;
}

function fromTheIntroDb(payload) {
    var result = [];
    [['intro', 'intro'], ['credits', 'outro']].forEach(function (pair) {
        var values = payload && payload[pair[0]];
        (Array.isArray(values) ? values : []).forEach(function (raw) {
            var from = dbTime(null, raw.start_ms);
            if (pair[1] === 'intro' && from == null) from = 0;
            result.push(segment(pair[1], from,
                dbTime(null, raw.end_ms), 'theintrodb'));
        });
    });
    return result;
}

function fromAniSkip(payload) {
    return ((payload && payload.found && payload.results) || []).map(function (raw) {
        var type = raw.skipType === 'op' || raw.skipType === 'mixed-op'
            ? 'intro'
            : (raw.skipType === 'ed' || raw.skipType === 'mixed-ed' ? 'outro' : null);
        if (!type || !raw.interval) return null;
        return segment(type, milliseconds(raw.interval.startTime), milliseconds(raw.interval.endTime),
            'aniskip', milliseconds(raw.episodeLength));
    }).filter(Boolean);
}

function plausible(item, durationMs) {
    if (!item || (item.type !== 'intro' && item.type !== 'outro')) return false;
    if (item.from == null || !isFinite(item.from) || item.from < 0 || item.from > durationMs + 10000) return false;
    if (item.type === 'intro' && item.to == null) return false;
    if (item.to != null && (!isFinite(item.to) || item.to <= item.from || item.to > durationMs + 10000)) return false;
    var length = item.to == null ? durationMs - item.from : item.to - item.from;
    if (length < 5000) return false;
    if (item.type === 'intro' && length > 200000) return false;
    if (item.type === 'outro' && length > 600000) return false;
    if (item.episodeLength != null) {
        var tolerance = Math.max(120000, durationMs * 0.05);
        if (Math.abs(item.episodeLength - durationMs) > tolerance) return false;
    }
    return true;
}

function strongestCluster(items, boundary) {
    if (items.length < 2) return items;
    var best = [];
    items.forEach(function (candidate) {
        var cluster = items.filter(function (other) {
            return Math.abs(other[boundary] - candidate[boundary]) <= BOUNDARY_TOLERANCE_MS;
        });
        if (cluster.length > best.length) best = cluster;
    });
    return best.length >= 2 ? best : [];
}

function strongestOutroCluster(items) {
    var cluster = strongestCluster(items, 'from');
    if (cluster.length || items.length < 2) return cluster;
    var sources = new Set(items.map(function (item) { return item.source; }));
    if (sources.size !== 1) return [];
    return [items.slice().sort(function (left, right) { return left.from - right.from; })[0]];
}

function reconcile(items, durationMs) {
    durationMs = Number(durationMs);
    if (!isFinite(durationMs) || durationMs <= 0) return { intro: null, outro: null };
    var valid = (items || []).filter(function (item) { return plausible(item, durationMs); });
    var intros = valid.filter(function (item) { return item.type === 'intro'; });
    var outros = valid.filter(function (item) { return item.type === 'outro'; });
    var introCluster = strongestCluster(intros, 'to');
    var outroCluster = strongestOutroCluster(outros);
    return {
        intro: introCluster.length ? {
            from: Math.min.apply(Math, introCluster.map(function (item) { return item.from; })),
            to: Math.max.apply(Math, introCluster.map(function (item) { return item.to; })),
        } : null,
        outro: outroCluster.length ? {
            from: Math.min.apply(Math, outroCluster.map(function (item) { return item.from; })),
            to: Math.min.apply(Math, outroCluster.map(function (item) {
                return item.to == null ? durationMs : item.to;
            })),
        } : null,
    };
}

function encodeQuery(values) {
    return Object.keys(values).filter(function (key) { return values[key] != null; }).map(function (key) {
        return encodeURIComponent(key) + '=' + encodeURIComponent(values[key]);
    }).join('&');
}

function safe(promise) { return promise.catch(function () { return null; }); }

function createResolver(options) {
    options = options || {};
    if (!options.identity || typeof options.identity.resolveIdentity !== 'function')
        throw new TypeError('identity resolver is required');
    if (typeof options.chapters !== 'function') throw new TypeError('chapter probe is required');
    var getJson = options.requestJson || requestJson;
    var now = options.now || Date.now;
    var cache = new Map();

    function fetchAlias(alias, durationMs) {
        var match = /^(tt\d+):(\d+):(\d+)$/.exec(alias.id || '');
        if (!match) return Promise.resolve([]);
        var query = { imdb_id: match[1], season: match[2], episode: match[3] };
        var intro = safe(getJson({ hostname: 'api.introdb.app', path: '/segments?' + encodeQuery(query),
            method: 'GET', headers: { Accept: 'application/json' } })).then(fromIntroDb);
        query.duration_ms = Math.round(durationMs);
        var theIntro = safe(getJson({ hostname: 'api.theintrodb.org', path: '/v3/media?' + encodeQuery(query),
            method: 'GET', headers: { Accept: 'application/json' } })).then(fromTheIntroDb);
        return Promise.all([intro, theIntro]).then(function (groups) { return groups[0].concat(groups[1]); });
    }

    function fetchAniSkip(identity, sid, durationMs) {
        var mal = Number(identity.ids && identity.ids.myanimelist);
        var episode = Number(String(sid).split(':').pop());
        if (!isFinite(mal) || mal <= 0 || !isFinite(episode) || episode <= 0) return Promise.resolve([]);
        var path = '/v2/skip-times/' + mal + '/' + episode + '?' + encodeQuery({
            'types[]': 'op',
            episodeLength: Math.round(durationMs / 1000),
        }) + '&types%5B%5D=ed&types%5B%5D=mixed-op&types%5B%5D=mixed-ed';
        return safe(getJson({ hostname: 'api.aniskip.com', path: path, method: 'GET',
            headers: { Accept: 'application/json' } })).then(fromAniSkip);
    }

    function resolve(input) {
        input = input || {};
        if (!/^kitsu:\d+:\d+$/.test(input.id || '') || !/^https?:\/\//.test(input.mediaUrl || '') ||
            !isFinite(Number(input.durationMs)) || Number(input.durationMs) <= 0)
            return Promise.resolve({ intro: null, outro: null });
        var cacheKey = input.id + '|' + input.mediaUrl + '|' + Math.round(Number(input.durationMs) / 1000);
        var hit = cache.get(cacheKey);
        if (hit && now() - hit.at < hit.ttl) return hit.value;
        var chapterPromise = safe(Promise.resolve().then(function () {
            return options.chapters(input.mediaUrl);
        })).then(fromChapters);
        var value = options.identity.resolveIdentity(input.id).then(function (identity) {
            var providers = (identity.aliases || []).map(function (alias) {
                return fetchAlias(alias, Number(input.durationMs));
            });
            providers.push(fetchAniSkip(identity, input.id, Number(input.durationMs)));
            return Promise.all([chapterPromise].concat(providers)).then(function (groups) {
                var all = [];
                groups.forEach(function (group) { if (Array.isArray(group)) all = all.concat(group); });
                return reconcile(all, Number(input.durationMs));
            });
        }).catch(function () { return { intro: null, outro: null }; });
        var tracked = value.then(function (result) {
            var positive = !!(result && (result.intro || result.outro != null));
            cache.set(cacheKey, { at: now(),
                ttl: positive ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS,
                value: Promise.resolve(result) });
            return result;
        });
        cache.set(cacheKey, { at: now(), ttl: NEGATIVE_CACHE_TTL_MS, value: tracked });
        return tracked;
    }

    return { resolve: resolve };
}

module.exports = {
    createResolver: createResolver,
    reconcile: reconcile,
    fromChapters: fromChapters,
    fromIntroDb: fromIntroDb,
    fromTheIntroDb: fromTheIntroDb,
    fromAniSkip: fromAniSkip,
};
