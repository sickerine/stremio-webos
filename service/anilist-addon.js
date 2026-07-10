// anilist-addon.js — a tiny in-process Stremio catalog addon.
//
// Problem: the Anime Kitsu addon's "Top Airing" catalog is junk (One Piece,
// Detective Conan, decades-old perpetual shows) and never reflects the actual
// current season. AniList's season query is perfect. But Torrentio only
// returns streams for kitsu: ids, not mal:/anilist:. So this addon uses
// AniList purely for the LISTING/ranking, maps each entry to its Kitsu id
// (via Kitsu's public mapping API), and emits kitsu: ids — keeping the entire
// existing pipeline (Kitsu meta, Torrentio streams, Kitsu->OpenSubtitles subs,
// our Japanese-audio/English-subs patches).
//
// Served by launch.js at /anime-airing/... on the app's own :8081 server.

var https = require('https');

var CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3h — season lists barely change
var cache = { at: 0, metas: null, inflight: null };

function getJson(options, body) {
    return new Promise(function (resolve, reject) {
        var req = https.request(options, function (res) {
            // Follow one redirect (Kitsu mapping include occasionally 3xx).
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                var u = require('url').parse(res.headers.location);
                return getJson({ hostname: u.hostname, path: u.path, method: 'GET',
                    headers: { 'Accept': 'application/json' } }).then(resolve, reject);
            }
            var chunks = '';
            res.on('data', function (d) { chunks += d; });
            res.on('end', function () {
                try { resolve(JSON.parse(chunks)); }
                catch (e) { reject(new Error('bad json from ' + options.hostname)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(12000, function () { req.destroy(new Error('timeout ' + options.hostname)); });
        if (body) req.write(body);
        req.end();
    });
}

function currentSeason() {
    var d = new Date();
    var m = d.getMonth(); // 0-11
    var season = m < 3 ? 'WINTER' : m < 6 ? 'SPRING' : m < 9 ? 'SUMMER' : 'FALL';
    return { season: season, year: d.getFullYear() };
}

function fetchAniListAiring() {
    // All currently-releasing anime (current season AND leftovers still airing
    // from previous seasons), ranked by TRENDING (time-decayed activity) so
    // the order reflects what people are actually watching right now rather
    // than all-time popularity (which would put perpetual long-runners first).
    var query = '{ Page(page:1, perPage:50) { media(type:ANIME, status:RELEASING, format_in:[TV, ONA], sort:TRENDING_DESC) ' +
        '{ idMal title { romaji english } coverImage { extraLarge large } bannerImage description(asHtml:false) ' +
        'genres averageScore seasonYear episodes } } }';
    var body = JSON.stringify({ query: query });
    return getJson({
        hostname: 'graphql.anilist.co', path: '/', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
            'Content-Length': Buffer.byteLength(body) }
    }, body).then(function (d) {
        var media = ((((d || {}).data || {}).Page || {}).media) || [];
        return media.filter(function (m) { return m && m.idMal; });
    });
}

function malToKitsu(malId) {
    return getJson({
        hostname: 'kitsu.io',
        path: '/api/edge/mappings?filter%5BexternalSite%5D=myanimelist/anime&filter%5BexternalId%5D=' +
            malId + '&include=item',
        method: 'GET', headers: { 'Accept': 'application/vnd.api+json' }
    }).then(function (d) {
        var inc = (d || {}).included || [];
        return inc.length ? inc[0].id : null;
    }).catch(function () { return null; });
}

function buildCatalog() {
    return fetchAniListAiring().then(function (media) {
        // Map all in parallel; keep only those with a Kitsu id (playable).
        return Promise.all(media.map(function (m) {
            return malToKitsu(m.idMal).then(function (kid) {
                if (!kid) return null;
                var ci = m.coverImage || {};
                return {
                    id: 'kitsu:' + kid,
                    type: 'anime',
                    name: (m.title.english || m.title.romaji),
                    poster: ci.extraLarge || ci.large || undefined,
                    posterShape: 'poster',
                    background: m.bannerImage || ci.extraLarge || undefined,
                    description: (m.description || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim() || undefined,
                    genres: (m.genres && m.genres.length) ? m.genres : undefined,
                    releaseInfo: m.seasonYear ? String(m.seasonYear) : undefined,
                    imdbRating: (typeof m.averageScore === 'number') ? (m.averageScore / 10).toFixed(1) : undefined
                };
            });
        })).then(function (items) { return items.filter(Boolean); });
    });
}

function getMetas() {
    var now = Date.now();
    if (cache.metas && (now - cache.at) < CACHE_TTL_MS) return Promise.resolve(cache.metas);
    if (cache.inflight) return cache.inflight;
    cache.inflight = buildCatalog().then(function (metas) {
        cache.metas = metas; cache.at = Date.now(); cache.inflight = null;
        return metas;
    }).catch(function (e) {
        cache.inflight = null;
        return cache.metas || []; // serve stale on failure, else empty
    });
    return cache.inflight;
}

var MANIFEST = {
    id: 'io.stremio.patched.anilist',
    version: '1.0.0',
    name: 'AniList Airing',
    description: 'Currently-airing anime from AniList (popularity), mapped to Kitsu ids so streams/subtitles keep working.',
    resources: ['catalog'],
    types: ['anime'],
    idPrefixes: ['kitsu:'],
    catalogs: [{ type: 'anime', id: 'anilist-airing', name: 'AniList Currently Airing' }]
};

// Returns { status, body } for a given addon path, or null if not our route.
function handle(pathname) {
    if (pathname === '/anime-airing/manifest.json')
        return Promise.resolve({ status: 200, body: JSON.stringify(MANIFEST) });
    if (pathname === '/anime-airing/catalog/anime/anilist-airing.json')
        return getMetas().then(function (metas) {
            return { status: 200, body: JSON.stringify({ metas: metas }) };
        });
    return null;
}

module.exports = { handle: handle, MANIFEST: MANIFEST, _buildCatalog: buildCatalog };
