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
        '{ id idMal title { romaji english } coverImage { extraLarge large } bannerImage description(asHtml:false) ' +
        'genres averageScore seasonYear episodes nextAiringEpisode { airingAt timeUntilAiring episode } } } }';
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
        return inc.length ? { kid: inc[0].id, at: inc[0].attributes || {} } : null;
    }).catch(function () { return null; });
}

// Fetch attributes for an id that came from the ARM fallback.
function kitsuAttrs(kid) {
    return getJson({
        hostname: 'kitsu.io', path: '/api/edge/anime/' + kid,
        method: 'GET', headers: { 'Accept': 'application/vnd.api+json' }
    }).then(function (d) {
        return ((d || {}).data || {}).attributes || {};
    }).catch(function () { return {}; });
}

// Fallback for entries Kitsu's own mapping table doesn't know yet (brand-new
// shows lag there ~15% of a season). ARM (relations.yuna.moe) maps
// anilist -> kitsu ids and covered 100% of the gaps in testing.
function anilistToKitsuARM(anilistId) {
    return getJson({
        hostname: 'relations.yuna.moe',
        path: '/api/v2/ids?source=anilist&id=' + anilistId,
        method: 'GET', headers: { 'Accept': 'application/json' }
    }).then(function (d) {
        var k = (d || {}).kitsu;
        return (typeof k === 'number') ? String(k) : null;
    }).catch(function () { return null; });
}

function buildCatalog() {
    return fetchAniListAiring().then(function (media) {
        // Map all in parallel; keep only those with a Kitsu id (playable).
        return Promise.all(media.map(function (m) {
            return malToKitsu(m.idMal).then(function (r) {
                if (r) return r;
                return anilistToKitsuARM(m.id).then(function (kid) {
                    if (!kid) return null;
                    return kitsuAttrs(kid).then(function (at) { return { kid: kid, at: at }; });
                });
            }).then(function (r) {
                if (!r) return null;
                // Display metadata comes from KITSU so the grid matches what the
                // detail page (Kitsu addon) shows; AniList only provides the
                // season list + ranking, and fills any missing fields.
                var at = r.at || {}, ci = m.coverImage || {};
                var alDesc = (m.description || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim();
                var nae = m.nextAiringEpisode || null;
                return {
                    id: 'kitsu:' + r.kid,
                    type: 'series',
                    // Marks our synthesized metas so the top preview keeps showing
                    // this list metadata instead of upgrading to the Kitsu addon's
                    // fetched meta (which differs and flickers). Detail page is
                    // unaffected — it renders the canonical meta as usual.
                    __ours: true,
                    // Detail-page deep link so the item popup's Play/Details
                    // buttons work (the app no-ops navigate(undefined) otherwise).
                    deepLinks: { metaDetailsVideos: '#/detail/series/kitsu:' + r.kid },
                    name: at.canonicalTitle || m.title.english || m.title.romaji,
                    poster: (at.posterImage && (at.posterImage.large || at.posterImage.original)) || ci.extraLarge || ci.large || undefined,
                    posterShape: 'poster',
                    background: (at.coverImage && at.coverImage.original) || m.bannerImage || ci.extraLarge || undefined,
                    description: at.synopsis || alDesc || undefined,
                    genres: (m.genres && m.genres.length) ? m.genres : undefined,
                    releaseInfo: (at.startDate ? at.startDate.slice(0, 4) : (m.seasonYear ? String(m.seasonYear) : undefined)),
                    imdbRating: (at.averageRating ? (parseFloat(at.averageRating) / 10).toFixed(1) : ((typeof m.averageScore === 'number') ? (m.averageScore / 10).toFixed(1) : undefined)),
                    // Extra fields for the weekly schedule page (ignored by the
                    // Stremio catalog board, consumed by /anime-airing/schedule-week).
                    banner: m.bannerImage || (at.coverImage && at.coverImage.original) || undefined,
                    airingAt: nae ? nae.airingAt : null,        // epoch seconds of the NEXT episode
                    nextEpisode: nae ? nae.episode : null,      // upcoming episode number
                    totalEpisodes: (typeof m.episodes === 'number') ? m.episodes : (at.episodeCount || null)
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

var schedCache = {};
function airingScheduleForKitsu(kitsuNumericId) {
    var c = schedCache[kitsuNumericId];
    if (c && (Date.now() - c.at) < 3600000) return Promise.resolve(c.map);
    return getJson({
        hostname: 'relations.yuna.moe',
        path: '/api/v2/ids?source=kitsu&id=' + kitsuNumericId,
        method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    }).then(function (d) {
        var alid = (d || {}).anilist;
        if (!alid) return {};
        var body = JSON.stringify({ query: '{ Media(id:' + alid + ') { airingSchedule(perPage:100) { nodes { episode airingAt } } } }' });
        return getJson({
            hostname: 'graphql.anilist.co', path: '/', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0', 'Content-Length': Buffer.byteLength(body) }
        }, body).then(function (r) {
            var nodes = (((((r || {}).data || {}).Media || {}).airingSchedule || {}).nodes) || [];
            var map = {};
            nodes.forEach(function (n) {
                if (n && n.episode && n.airingAt) map[n.episode] = new Date(n.airingAt * 1000).toISOString();
            });
            return map;
        });
    }).catch(function () { return {}; }).then(function (map) {
        schedCache[kitsuNumericId] = { at: Date.now(), map: map };
        return map;
    });
}

// ---- Paginating anime SEARCH (separate from the airing catalog) ------------
// The Kitsu addon and Kitsu's own text API both cap search at ~20 and ignore
// paging (offset is a no-op). AniList search paginates properly, so we search
// AniList and map each hit to its Kitsu id (same pipeline as the airing tab),
// giving real infinite-scroll anime search that still returns kitsu: ids.
var searchCache = {}; // key `${q}|${page}` -> { at, result }
function search(query, page) {
    query = (query || '').trim();
    if (!query) return Promise.resolve({ metas: [], hasNext: false });
    page = Math.max(1, parseInt(page, 10) || 1);
    var key = query.toLowerCase() + '|' + page;
    var c = searchCache[key];
    if (c && (Date.now() - c.at) < 10 * 60 * 1000) return Promise.resolve(c.result);
    var body = JSON.stringify({
        query: 'query($s:String,$p:Int){ Page(page:$p, perPage:20){ pageInfo{ hasNextPage } ' +
            'media(search:$s, type:ANIME, sort:POPULARITY_DESC){ id idMal title{ romaji english } ' +
            'coverImage{ extraLarge large } bannerImage description(asHtml:false) genres averageScore seasonYear episodes } } }',
        variables: { s: query, p: page }
    });
    return getJson({
        hostname: 'graphql.anilist.co', path: '/', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0', 'Content-Length': Buffer.byteLength(body) }
    }, body).then(function (d) {
        var pg = (((d || {}).data || {}).Page) || {};
        var media = pg.media || [];
        var hasNext = !!(pg.pageInfo && pg.pageInfo.hasNextPage);
        return Promise.all(media.map(function (m) {
            return (m.idMal ? malToKitsu(m.idMal) : Promise.resolve(null)).then(function (r) {
                if (r) return r;
                return anilistToKitsuARM(m.id).then(function (kid) {
                    if (!kid) return null;
                    return kitsuAttrs(kid).then(function (at) { return { kid: kid, at: at }; });
                });
            }).then(function (r) {
                if (!r) return null;
                var at = r.at || {}, ci = m.coverImage || {};
                var alDesc = (m.description || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim();
                return {
                    id: 'kitsu:' + r.kid,
                    type: 'series',
                    // Marks our synthesized metas so the top preview keeps showing
                    // this list metadata instead of upgrading to the Kitsu addon's
                    // fetched meta (which differs and flickers). Detail page is
                    // unaffected — it renders the canonical meta as usual.
                    __ours: true,
                    // Detail-page deep link so the item popup's Play/Details
                    // buttons work (the app no-ops navigate(undefined) otherwise).
                    deepLinks: { metaDetailsVideos: '#/detail/series/kitsu:' + r.kid },
                    name: at.canonicalTitle || m.title.english || m.title.romaji,
                    poster: (at.posterImage && (at.posterImage.large || at.posterImage.original)) || ci.extraLarge || ci.large || undefined,
                    posterShape: 'poster',
                    background: (at.coverImage && at.coverImage.original) || m.bannerImage || ci.extraLarge || undefined,
                    description: at.synopsis || alDesc || undefined,
                    genres: (m.genres && m.genres.length) ? m.genres : undefined,
                    releaseInfo: (at.startDate ? at.startDate.slice(0, 4) : (m.seasonYear ? String(m.seasonYear) : undefined)),
                    imdbRating: (at.averageRating ? (parseFloat(at.averageRating) / 10).toFixed(1) : ((typeof m.averageScore === 'number') ? (m.averageScore / 10).toFixed(1) : undefined))
                };
            });
        })).then(function (items) {
            var result = { metas: items.filter(Boolean), hasNext: hasNext };
            searchCache[key] = { at: Date.now(), result: result };
            return result;
        });
    }).catch(function () { return { metas: [], hasNext: false }; });
}

// ---- "Next Up" builder for the Home library row -----------------------------
// Takes full library items (with watch state) and computes, per show: the
// episode to surface (in-progress with %, or the next unwatched one), plus a
// sort key = the newest aired episode date ("last episode added").
var AIO_HOST = 'aiometadatafortheweebs.midnightignite.me';
var AIO_PATH = '/stremio/e403afb8-02d5-416e-b520-6b9bb80e8e2f';
var aioCache = {};
function fetchAIOMeta(id) {
    var c = aioCache[id];
    if (c && (Date.now() - c.at) < 30 * 60 * 1000) return Promise.resolve(c.meta);
    return getJson({ hostname: AIO_HOST, path: AIO_PATH + '/meta/series/' + encodeURIComponent(id) + '.json',
        method: 'GET', headers: { 'Accept': 'application/json' } }).then(function (d) {
        var m = (d || {}).meta || null;
        aioCache[id] = { at: Date.now(), meta: m };
        return m;
    }).catch(function () { return null; });
}
var metaCache = {};
function fetchSeriesMeta(id) {
    var c = metaCache[id];
    if (c && (Date.now() - c.at) < 30 * 60 * 1000) return Promise.resolve(c.meta);
    var opts = /^kitsu:/.test(id)
        ? { hostname: 'anime-kitsu.strem.fun', path: '/meta/series/' + encodeURIComponent(id) + '.json',
            method: 'GET', headers: { 'Accept': 'application/json' } }
        : { hostname: 'v3-cinemeta.strem.io', path: '/meta/series/' + id + '.json',
            method: 'GET', headers: { 'Accept': 'application/json' } };
    return getJson(opts).then(function (d) {
        var m = (d || {}).meta || null;
        metaCache[id] = { at: Date.now(), meta: m };
        return m;
    }).catch(function () { return null; });
}

function buildNextUp(libItems) {
    var cands = (libItems || []).filter(function (it) {
        return it && !it.removed && 'series' === it.type && it.state && it.state.lastWatched;
    }).sort(function (a, b) {
        return new Date(b.state.lastWatched) - new Date(a.state.lastWatched);
    }).slice(0, 20);
    return Promise.all(cands.map(function (it) {
        var isKitsu = /^kitsu:/.test(it._id);
        var schedP = isKitsu ? airingScheduleForKitsu(it._id.split(':')[1]) : Promise.resolve({});
        return Promise.all([fetchSeriesMeta(it._id), schedP]).then(function (r) {
            var meta = r[0], sched = r[1] || {};
            if (!meta || !(meta.videos || []).length) return null;
            var vids = meta.videos.filter(function (v) {
                return v && v.id && (void 0 === v.season || v.season > 0); // skip specials
            });
            vids.sort(function (a, b) {
                var ae = a.episode || parseInt(String(a.id).split(':').pop(), 10) || 0;
                var be = b.episode || parseInt(String(b.id).split(':').pop(), 10) || 0;
                return (a.season || 0) - (b.season || 0) || ae - be;
            });
            // Kitsu premiere-stamps every episode of airing shows with one date;
            // prefer the AniList schedule for real airdates in that case.
            var uniq = {};
            vids.forEach(function (v) { if (v.released) uniq[v.released] = 1; });
            var stamped = isKitsu && vids.length > 1 && Object.keys(uniq).length <= 1;
            function relOf(v) {
                if (isKitsu) {
                    var ep = parseInt(String(v.id).split(':').pop(), 10);
                    if (sched[ep]) return sched[ep];
                    if (stamped) return null;
                }
                return v.released || null;
            }
            var nowIso = new Date().toISOString();
            var released = vids.filter(function (v) { var r = relOf(v); return r && r <= nowIso; });
            if (!released.length) released = vids; // no usable dates -> assume aired
            var st = it.state, idx = -1;
            if (st.video_id) for (var i = 0; i < released.length; i++)
                if (released[i].id === st.video_id) { idx = i; break; }
            var frac = st.duration > 0 ? st.timeOffset / st.duration : 0;
            var target, prog = 0;
            if (idx < 0) {
                // video_id can point at a not-yet-aired episode (the core
                // advances past the last finished one) -> caught up, show the
                // countdown; only genuinely-unwatched shows start at EP 1.
                var pointsAhead = st.video_id && vids.some(function (v) { return v.id === st.video_id; });
                target = pointsAhead ? null : released[0];
            }
            else if (frac >= 0.95) target = released[idx + 1] || null;
            else { target = released[idx]; prog = frac > 0.02 ? frac : 0; }
            var latest = '';
            released.forEach(function (v) { var r = relOf(v) || v.released || ''; if (r > latest) latest = r; });
            // Caught up -> surface the next unaired episode instead.
            var un = null;
            if (!target) for (var j = 0; j < vids.length; j++) {
                var rr = relOf(vids[j]); if (rr && rr > nowIso) { un = { v: vids[j], r: rr }; break; }
            }
            var shown = target || (un && un.v) || null;
            var showName = meta.name || it.name;
            var out = {
                id: it._id,
                type: 'series',
                name: showName,
                // Episode-card look: landscape episode still (like the detail
                // page's episode list), falling back to background art.
                posterShape: 'landscape',
                background: meta.background || undefined,
                description: meta.description || undefined,
                __ours: true,
                __latest: latest,
                deepLinks: { metaDetailsVideos: '#/detail/series/' + encodeURIComponent(it._id) +
                    (target ? '/' + encodeURIComponent(target.id) : '') }
            };
            var thumbP = Promise.resolve(shown && shown.thumbnail);
            if (isKitsu && shown && !shown.thumbnail)
                thumbP = fetchAIOMeta(it._id).then(function (am) {
                    var v = am && (am.videos || []).find(function (x) { return x.id === shown.id; });
                    return (v && v.thumbnail) || null;
                });
            return thumbP.then(function (thumb) {
                out.poster = thumb || meta.background || meta.poster || it.poster || undefined;
                function epLabelOf(v) {
                    var ep = v.episode || parseInt(String(v.id).split(':').pop(), 10);
                    return (!isKitsu && null != v.season) ? ('S' + v.season + 'E' + ep) : ('EP ' + ep);
                }
                if (target) {
                    out.nextUp = { show: showName, label: (prog ? '' : 'NEXT · ') + epLabelOf(target), progress: Math.round(100 * prog) };
                } else if (un) {
                    out.nextUp = { show: showName, label: epLabelOf(un.v), progress: 0 };
                    out.airingAt = Math.floor(new Date(un.r).getTime() / 1000); // client appends live countdown
                } else {
                    out.nextUp = { show: showName, label: 'UP TO DATE', progress: 0 };
                }
                return out;
            });
        });
    })).then(function (list) {
        return list.filter(Boolean).sort(function (a, b) {
            return String(b.__latest || '').localeCompare(String(a.__latest || ''));
        }).slice(0, 15).map(function (x) { delete x.__latest; return x; });
    });
}

var MANIFEST = {
    id: 'io.stremio.patched.anilist',
    version: '1.0.0',
    name: 'AniList Airing',
    description: 'Currently-airing anime from AniList (popularity), mapped to Kitsu ids so streams/subtitles keep working.',
    resources: ['catalog'],
    types: ['series'],
    idPrefixes: ['kitsu:'],
    catalogs: [{ type: 'series', id: 'anilist-airing', name: 'AniList Currently Airing' }]
};

// Returns { status, body } for a given addon path, or null if not our route.
function handle(pathname) {
    var sm = /^\/anime-airing\/schedule\/(\d+)\.json$/.exec(pathname);
    if (sm)
        return airingScheduleForKitsu(sm[1]).then(function (map) {
            return { status: 200, body: JSON.stringify(map) };
        });
    if (pathname === '/anime-airing/manifest.json')
        return Promise.resolve({ status: 200, body: JSON.stringify(MANIFEST) });
    if (pathname === '/anime-airing/catalog/series/anilist-airing.json' || pathname === '/anime-airing/catalog/anime/anilist-airing.json')
        return getMetas().then(function (metas) {
            return { status: 200, body: JSON.stringify({ metas: metas }) };
        });
    // Weekly schedule feed for the native Anime page (relevance order + per-show
    // airing time/episode info; the client groups by weekday and ticks timers).
    if (pathname === '/anime-airing/schedule-week.json')
        return getMetas().then(function (metas) {
            return { status: 200, body: JSON.stringify({ metas: metas }) };
        });
    return null;
}

module.exports = { handle: handle, MANIFEST: MANIFEST, _buildCatalog: buildCatalog, search: search, buildNextUp: buildNextUp };
