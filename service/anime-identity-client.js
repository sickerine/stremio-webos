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

    function emptyIdentity() { return { ids: {}, titles: [], aliases: [] }; }

    function resolveIdentity(sid) {
        if (!/^kitsu:\d+:\d+$/.test(sid || '')) return Promise.resolve(emptyIdentity());
        var hit = cache.get(sid);
        if (hit && now() - hit.at < hit.ttl) return hit.value;
        var value = requestJson({
            hostname: hostname,
            path: '/identity/series/' + encodeURIComponent(sid) + '.json',
            method: 'GET',
            headers: { Accept: 'application/json' },
        }).then(function (payload) {
            payload = payload || {};
            var seen = {};
            var aliases = (payload.aliases || []).filter(function (alias) {
                var id = alias && alias.id;
                if (alias.confidence !== 'verified' || !/^tt\d+:\d+:\d+$/.test(id || '') || seen[id])
                    return false;
                seen[id] = true;
                return true;
            });
            var identity = {
                ids: payload.ids && typeof payload.ids === 'object' ? payload.ids : {},
                titles: Array.isArray(payload.titles) ? payload.titles.filter(function (title) {
                    return typeof title === 'string' && title.trim();
                }) : [],
                aliases: aliases,
            };
            var hasData = aliases.length || Object.keys(identity.ids).length;
            cache.set(sid, { at: now(), ttl: hasData ? POSITIVE_TTL : NEGATIVE_TTL,
                value: Promise.resolve(identity) });
            return identity;
        }).catch(function () {
            cache.delete(sid);
            return emptyIdentity();
        });
        cache.set(sid, { at: now(), ttl: NEGATIVE_TTL, value: value });
        return value;
    }

    function resolveEpisode(sid) {
        return resolveIdentity(sid).then(function (identity) {
            return identity.aliases.map(function (alias) { return alias.id; });
        });
    }

    return { resolveIdentity: resolveIdentity, resolveEpisode: resolveEpisode };
}

module.exports = { createIdentityClient: createIdentityClient };
