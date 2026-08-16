'use strict';

var DEFAULT_HOST = 'stremio-nyaa.vercel.app';
var POSITIVE_TTL = 6 * 60 * 60 * 1000;
var NEGATIVE_TTL = 10 * 60 * 1000;

function createIdentityClient(requestJson, options) {
    if (typeof requestJson !== 'function') throw new TypeError('requestJson is required');
    options = options || {};
    var hostname = options.hostname || DEFAULT_HOST;
    var now = options.now || Date.now;
    var cache = new Map();

    function resolveEpisode(sid) {
        if (!/^kitsu:\d+:\d+$/.test(sid || '')) return Promise.resolve([]);
        var hit = cache.get(sid);
        if (hit && now() - hit.at < hit.ttl) return hit.value;
        var value = requestJson({
            hostname: hostname,
            path: '/identity/series/' + encodeURIComponent(sid) + '.json',
            method: 'GET',
            headers: { Accept: 'application/json' },
        }).then(function (payload) {
            var seen = {};
            var ids = ((payload || {}).aliases || []).filter(function (alias) {
                var id = alias && alias.id;
                if (alias.confidence !== 'verified' || !/^tt\d+:\d+:\d+$/.test(id || '') || seen[id])
                    return false;
                seen[id] = true;
                return true;
            }).map(function (alias) { return alias.id; });
            cache.set(sid, { at: now(), ttl: ids.length ? POSITIVE_TTL : NEGATIVE_TTL,
                value: Promise.resolve(ids) });
            return ids;
        }).catch(function () {
            cache.delete(sid);
            return [];
        });
        cache.set(sid, { at: now(), ttl: NEGATIVE_TTL, value: value });
        return value;
    }

    return { resolveEpisode: resolveEpisode };
}

module.exports = { createIdentityClient: createIdentityClient };
