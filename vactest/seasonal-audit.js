// SEASONAL STREAM-RESOLUTION AUDIT — verifies that every anime from the past
// three seasons resolves to streams for the CORRECT episode through the same
// pipeline the TV uses:
//
//   1. Torrentio queried with the season-local Kitsu id  (kitsu:<id>:<ep>)
//   2. If empty: subMap() from service/anilist-addon.js (standaloneMap via
//      Cinemeta title+airdate, then franchiseMap via AIOMetadata) -> retry
//      Torrentio with the mapped tt<id>:<s>:<e>
//
// This is the exact logic deployed in the FETCH_INTERCEPT of launch.js; the
// mapper is required from the production module, not reimplemented, so a pass
// here means the TV path works.
//
// Lesson baked in from the Bleach TYBW investigation (2026-07-27): a non-empty
// streams array is NOT a pass. Every returned title is parsed for episode
// markers (SxxEyy, " - NN", "Ep NN", batch ranges) and compared against both
// the season-local and the mapped canonical numbering. "Streams exist but none
// name the requested episode" is reported, not swallowed.
//
// Read-only: queries public endpoints only. Never touches the TV.
// Needs Node >= 18 (global fetch). Run from anywhere:
//
//   node vactest/seasonal-audit.js                     # 3 seasons, first+latest ep
//   node vactest/seasonal-audit.js --target=nyaa       # query Nyaa.si RSS directly
//   node vactest/seasonal-audit.js --limit=5           # smoke run, 5 shows/season
//   node vactest/seasonal-audit.js --episodes=all      # every aired episode
//   node vactest/seasonal-audit.js --filter=bleach     # only matching titles
//   node vactest/seasonal-audit.js --fresh             # ignore the disk cache
//   TORRENTIO_CONFIG='providers=nyaasi,...' node ...   # mirror the TV's config
//
// --target=nyaa is the pre-extension validation: it never calls Torrentio.
// Instead it builds search queries from the show's titles (the job the future
// addon must do), fetches nyaa.si RSS, verifies episode markers in the results,
// and compares against previously CACHED Torrentio results as the expectation
// oracle ("Torrentio had streams here — did our own Nyaa query find them?").
// The winning query strategy per episode is recorded in the report, so the
// full run doubles as a dataset for designing the addon's query builder.
//
// Results: console summary + vactest/out/seasonal-audit-report.json.
// Torrentio rate-limits bursts (seen live on 2026-07-27), so requests are
// globally paced and 429s retried with backoff; a disk cache (12h TTL) makes
// reruns resume instead of re-hammering.

var path = require('path');
var fs = require('fs');
var addon = require(path.join(__dirname, '..', 'service', 'anilist-addon.js'));

var TORRENTIO_HOST = process.env.TORRENTIO_HOST || 'torrentio.strem.fun';
var TORRENTIO_CONFIG = process.env.TORRENTIO_CONFIG || ''; // e.g. 'providers=nyaasi|debridoptions=...'
var OUT_DIR = path.join(__dirname, 'out');
var CACHE_FILE = path.join(OUT_DIR, 'seasonal-audit-cache.json');
var REPORT_FILE = path.join(OUT_DIR, 'seasonal-audit-report.json');
var CACHE_TTL = 12 * 60 * 60 * 1000;
var TORRENTIO_GAP_MS = 350;   // global pacing between Torrentio hits
var TOP_STREAMS = 8;          // how many returned titles to inspect per query

var argv = {};
process.argv.slice(2).forEach(function (a) {
    var m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) argv[m[1]] = m[2] === undefined ? true : m[2];
});
var SEASON_COUNT = +(argv.seasons || 3);
var LIMIT = argv.limit ? +argv.limit : Infinity;
var EPISODES_MODE = argv.episodes || 'first,latest'; // first | latest | first,latest | all
var FILTER = (argv.filter || '').toLowerCase();
var CONCURRENCY = +(argv.concurrency || 4);
var FRESH = !!argv.fresh;
var TARGET = argv.target || 'torrentio'; // torrentio | nyaa | animetosho
var NYAA_GAP_MS = 1100; // be polite to nyaa.si — one request per second
var REPORT_TARGET_FILE = path.join(OUT_DIR,
    'seasonal-audit-report' + (TARGET === 'torrentio' ? '' : '-' + TARGET) + '.json');

// ---------------------------------------------------------------- utilities

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function fetchBody(url, opts, asText, tries) {
    tries = tries || 0;
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, 20000);
    try {
        var res = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
        if (res.status === 429 || res.status >= 500) throw new Error('http ' + res.status);
        if (!res.ok) return null;
        return asText ? await res.text() : await res.json();
    } catch (e) {
        if (tries >= 3) throw e;
        var backoff = [2000, 8000, 20000][tries];
        process.stderr.write('  retry in ' + backoff / 1000 + 's (' + e.message + '): ' + url + '\n');
        await sleep(backoff);
        return fetchBody(url, opts, asText, tries + 1);
    } finally {
        clearTimeout(t);
    }
}
function fetchJson(url, opts) { return fetchBody(url, opts, false); }
function fetchText(url, opts) { return fetchBody(url, opts, true); }

async function mapLimit(items, limit, fn) {
    var out = new Array(items.length), i = 0;
    async function worker() {
        while (i < items.length) { var idx = i++; out[idx] = await fn(items[idx], idx); }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

var cache = { torrentio: {}, map: {}, nyaa: {}, ids: {}, tosho: {} };
try { cache = Object.assign(cache, JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))); } catch (_) {}
function cacheGet(bucket, key) {
    var c = cache[bucket][key];
    return (!FRESH && c && Date.now() - c.at < CACHE_TTL) ? c : null;
}
function cachePut(bucket, key, val) {
    cache[bucket][key] = Object.assign({ at: Date.now() }, val);
}
function cacheFlush() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

// ------------------------------------------------------------------ AniList

function pastSeasons(n) {
    var order = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
    var d = new Date();
    var idx = Math.floor(d.getMonth() / 3), year = d.getFullYear();
    var out = [];
    for (var i = 0; i < n; i++) {
        out.push({ season: order[idx], year: year });
        if (--idx < 0) { idx = 3; year--; }
    }
    return out;
}

async function fetchSeasonList(season) {
    var query = 'query($season:MediaSeason,$year:Int,$page:Int){' +
        'Page(page:$page,perPage:50){pageInfo{hasNextPage}' +
        'media(season:$season,seasonYear:$year,type:ANIME,format_in:[TV,ONA],sort:POPULARITY_DESC){' +
        'id idMal title{romaji english} synonyms status episodes popularity nextAiringEpisode{episode}}}}';
    var media = [], page = 1, hasNext = true;
    while (hasNext && media.length < 200) {
        var d = await fetchJson('https://graphql.anilist.co/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: query, variables: { season: season.season, year: season.year, page: page } })
        });
        var p = (((d || {}).data || {}).Page) || {};
        media = media.concat(p.media || []);
        hasNext = (p.pageInfo || {}).hasNextPage;
        page++;
        await sleep(700); // AniList allows ~90 req/min
    }
    return media.filter(function (m) { return m && m.status !== 'NOT_YET_RELEASED'; });
}

// Mirrors malToKitsu()/anilistToKitsuARM() in service/anilist-addon.js (not
// exported there; the RESOLUTION path below does use the exported production code).
async function toKitsuId(m) {
    if (m.idMal) {
        var d = await fetchJson('https://kitsu.io/api/edge/mappings?filter%5BexternalSite%5D=myanimelist/anime' +
            '&filter%5BexternalId%5D=' + m.idMal + '&include=item',
            { headers: { Accept: 'application/vnd.api+json' } }).catch(function () { return null; });
        var inc = (d || {}).included || [];
        if (inc.length) return inc[0].id;
    }
    var arm = await fetchJson('https://relations.yuna.moe/api/v2/ids?source=anilist&id=' + m.id)
        .catch(function () { return null; });
    return (arm && typeof arm.kitsu === 'number') ? String(arm.kitsu) : null;
}

// ---------------------------------------------------------------- Torrentio

var torrentioLast = 0;
async function torrentioTitles(id) {
    var key = TORRENTIO_HOST + '/' + TORRENTIO_CONFIG + '/' + id;
    var hit = cacheGet('torrentio', key);
    if (hit) return hit.titles;
    var wait = torrentioLast + TORRENTIO_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    torrentioLast = Date.now();
    var base = 'https://' + TORRENTIO_HOST + '/' + (TORRENTIO_CONFIG ? TORRENTIO_CONFIG + '/' : '');
    var d = await fetchJson(base + 'stream/series/' + encodeURIComponent(id) + '.json');
    var titles = ((d || {}).streams || []).slice(0, TOP_STREAMS).map(function (s) {
        return String(s.title || s.name || '').replace(/\n/g, ' | ');
    });
    cachePut('torrentio', key, { titles: titles });
    return titles;
}

// The production fallback mapper (standaloneMap -> franchiseMap), disk-cached
// across runs because subMap's own cache is in-process only.
async function mappedId(sid) {
    var hit = cacheGet('map', sid);
    if (hit) return hit.id;
    var id = await addon.subMap(sid).catch(function () { return null; });
    cachePut('map', sid, { id: id || null });
    return id || null;
}

// ------------------------------------------------------------------- Nyaa.si

function decodeEntities(s) {
    return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); });
}

var nyaaLast = 0;
async function nyaaSearch(q, cat) {
    cat = cat || '1_2'; // Anime - English-translated; '1_0' = all anime incl. raws
    var key = (cat === '1_2' ? '' : cat + '|') + q.toLowerCase();
    var hit = cacheGet('nyaa', key);
    if (hit) return hit.titles;
    var wait = nyaaLast + NYAA_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    nyaaLast = Date.now();
    var xml = await fetchText('https://nyaa.si/?page=rss&f=0&c=' + cat + '&q=' + encodeURIComponent(q));
    var titles = [], re = /<item>([\s\S]*?)<\/item>/g, m;
    while ((m = re.exec(xml || '')) && titles.length < 30) {
        var t = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(m[1]);
        var s = /<nyaa:seeders>(\d+)<\/nyaa:seeders>/.exec(m[1]);
        if (t) titles.push(decodeEntities(t[1].trim()) + ' | 👤 ' + (s ? s[1] : '?') + ' ⚙️ NyaaSi');
    }
    cachePut('nyaa', key, { titles: titles });
    return titles;
}

function cleanTitle(t) {
    return String(t || '').normalize('NFKC')
        .replace(/[''ʼ]/g, '') // "Let's" -> "Lets", not the useless tokens "Let s"
        .replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Season ordinal stated in the show's own title variants ("Season 4", "2nd
// Season", "II", a trailing bare "2"). Lets a release's explicit season tag
// confirm an otherwise-ambiguous match even when the mapped id was flattened.
function seasonOrdinalFromNames(names) {
    var ROMAN = { II: 2, III: 3, IV: 4, V: 5 };
    for (var i = 0; i < names.length; i++) {
        var s = String(names[i]);
        var m = /Season\s*(\d{1,2})|(\d{1,2})(?:nd|rd|th)\s+Season|\bS(\d{1,2})\b/i.exec(s);
        var r = /\b(II|III|IV|V)\b/.exec(s);
        var t = /(?:^|\s)(\d{1,2})\s*$/.exec(s.trim());
        var v = m ? +(m[1] || m[2] || m[3]) : r ? ROMAN[r[1]] : t ? +t[1] : null;
        if (v && v >= 2 && v <= 20) return v;
    }
    return null;
}

// Candidate queries, most specific first. Short-title + season-local number is
// AMBIGUOUS when the show also has an absolute number ("Bleach 01" finds the
// 2004 episode 1, not TYBW part 4 ep 1) — those matches downgrade to a WARN.
function buildNyaaQueries(names, ep, abs) {
    var full = names.map(cleanTitle).filter(Boolean);
    var shorts = names.map(function (n) { return cleanTitle(String(n).split(/[:\-–—(]/)[0]); })
        .filter(function (s) { return s && s.split(' ').length <= 4; });
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var out = [], seen = {};
    function add(q, ambiguous) {
        var k = q.toLowerCase();
        if (!q || seen[k]) return;
        seen[k] = 1;
        out.push({ q: q, ambiguous: !!ambiguous });
    }
    full.slice(0, 5).forEach(function (n) { add(n + ' ' + pad(ep)); });
    if (abs && abs !== ep) {
        shorts.slice(0, 2).forEach(function (n) { add(n + ' ' + pad(abs)); });
        full.slice(0, 2).forEach(function (n) { add(n + ' ' + pad(abs)); });
    }
    shorts.slice(0, 2).forEach(function (n) { add(n + ' ' + pad(ep), abs && abs !== ep); });
    // Distinctive prefixes: first two words of the primary title, plus the
    // first word of each title variant when it looks distinctive (long words —
    // "Magilumiere" — rather than generic ones). Catches word-spacing
    // mismatches at the cost of ambiguity, so these matches must survive the
    // season-marker / absolute-number confirmation.
    var prefixes = [full[0] && full[0].split(' ').slice(0, 2).join(' ')];
    full.slice(0, 3).forEach(function (n) {
        var w = n.split(' ')[0];
        if (w && w.length >= 7) prefixes.push(w);
    });
    prefixes.filter(Boolean).forEach(function (p) {
        if (p.length < 4 || p.split(' ').some(function (w) { return w.length < 3; })) return;
        add(p + ' ' + pad(ep), true);
        if (abs && abs !== ep) add(p + ' ' + pad(abs), true);
    });
    full.slice(0, 2).forEach(function (n) { add(n); }); // catch-all: batches, odd numbering
    return out.slice(0, 12);
}

// "Season 2" / "2nd Season" / "S02" / roman "II" in a release name confirms
// the mapped season, upgrading an ambiguous short-title match to a real pass.
function hasSeasonMarker(title, s) {
    if (!s || s < 2) return false;
    var roman = { 2: 'II', 3: 'III', 4: 'IV', 5: 'V' }[s];
    var re = new RegExp('(?:\\bS0?' + s + 'E|\\bSeason\\s*' + s + '\\b|\\b' + s +
        '(?:nd|rd|th)\\s+Season\\b' + (roman ? '|\\b' + roman + '\\b' : '') + ')', 'i');
    return re.test(stripNoise(title));
}

// Looser variant for a NAME-derived ordinal: also accepts a bare "S3" token
// ("[ASW] ... S3 - 01") or a standalone digit ("...Ken 2 - 01"). Resolution/
// year/CRC noise is stripped first, so a lone digit is a meaningful token.
function hasLooseSeasonMarker(title, s) {
    if (!s || s < 2) return false;
    if (hasSeasonMarker(title, s)) return true;
    return new RegExp('\\bS0?' + s + '\\b|(?:^|\\s)0?' + s + '(?:\\s|$)').test(stripNoise(title));
}

// What did Torrentio return for this episode in earlier runs? Read-only cache
// lookup (TTL ignored — historical truth is fine as an expectation oracle).
function torrentioOracle(sid, mapped) {
    var pre = TORRENTIO_HOST + '/' + TORRENTIO_CONFIG + '/';
    var direct = cache.torrentio[pre + sid];
    var viaMap = mapped && cache.torrentio[pre + mapped];
    if ((direct && direct.titles.length) || (viaMap && viaMap.titles.length)) return 'had-streams';
    if (direct || viaMap) return 'empty';
    return 'unknown';
}

async function auditEpisodeNyaa(kitsuId, ep, names) {
    var sid = 'kitsu:' + kitsuId + ':' + ep;
    // subMap/absoluteEpisode hit Cinemeta + AIOMetadata only, never Torrentio;
    // the absolute number is needed both for query building and verification.
    var mapped = await mappedId(sid);
    var expMapped = null, abs = null;
    if (mapped) {
        var mm = /^tt\d+:(\d+):(\d+)$/.exec(mapped);
        if (mm) expMapped = { s: +mm[1], e: +mm[2] };
        abs = await absoluteEpisode(mapped);
    }
    var exp = { local: ep, mapped: expMapped, abs: abs };
    var ordinal = seasonOrdinalFromNames(names);
    var queries = buildNyaaQueries(names, ep, abs);
    var batchBest = null;
    function finish(verdict, q, n, top) {
        return { ep: ep, sid: sid, route: 'nyaa', mappedId: mapped, abs: abs, query: q,
            verdict: verdict, streams: n, sample: top, oracle: torrentioOracle(sid, mapped) };
    }
    var ambiguousBest = null;
    for (var i = 0; i < queries.length; i++) {
        var items = await nyaaSearch(queries[i].q);
        var exact = [], batch = [];
        items.forEach(function (t) {
            var k = classifyTitle(t, exp);
            if (k === 'exact') exact.push(t);
            else if (k === 'batch') batch.push(t);
        });
        if (exact.length) {
            if (!queries[i].ambiguous)
                return finish('PASS', queries[i].q, exact.length, exact[0]);
            // Ambiguous query, but a season marker in the release name — or a
            // hit on the franchise-unique ABSOLUTE episode number — settles it.
            var confirmed = exact.filter(function (t) {
                return (expMapped && hasSeasonMarker(t, expMapped.s)) ||
                    (ordinal && hasLooseSeasonMarker(t, ordinal)) ||
                    (abs && abs !== ep &&
                        classifyTitle(t, { local: -1, mapped: null, abs: abs }) === 'exact');
            });
            if (confirmed.length)
                return finish('PASS', queries[i].q, confirmed.length, confirmed[0]);
            if (!ambiguousBest)
                ambiguousBest = { q: queries[i].q, n: exact.length, top: exact[0] };
            continue; // keep looking for an unambiguous hit
        }
        if (batch.length && !batchBest)
            batchBest = { q: queries[i].q, n: batch.length, top: batch[0] };
    }
    if (ambiguousBest) return finish('WARN_AMBIGUOUS', ambiguousBest.q, ambiguousBest.n, ambiguousBest.top);
    if (batchBest) return finish('PASS_BATCH', batchBest.q, batchBest.n, batchBest.top);
    // Nothing in English-translated: probe all anime categories (incl. raws)
    // so the report separates "bad query" from "no subbed release exists".
    for (var j = 0; j < Math.min(2, queries.length); j++) {
        var raws = await nyaaSearch(queries[j].q, '1_0');
        var rawExact = raws.filter(function (t) { return classifyTitle(t, exp) === 'exact'; });
        if (rawExact.length)
            return finish('WARN_RAW_ONLY', queries[j].q + ' [c=1_0]', rawExact.length, rawExact[0]);
    }
    return finish('FAIL_NOT_FOUND', queries.map(function (x) { return x.q; }).join(' ; '), 0, null);
}

// --------------------------------------------------------------- Animetosho
//
// --target=animetosho tests the ID-JOIN architecture: Animetosho mirrors Nyaa
// and tags every release with its AniDB anime id, so identity comes from
// kitsu -> AniDB (ARM) -> feed.animetosho.org?aid=N — no title queries, no
// wrong-show risk, no season disambiguation. Only the intra-show episode
// number is still parsed from release names (local or absolute both accepted,
// unambiguous because the show identity is already guaranteed by the join).

async function kitsuToAnidb(kid) {
    var hit = cacheGet('ids', String(kid));
    if (hit) return hit.anidb;
    var d = await fetchJson('https://relations.yuna.moe/api/v2/ids?source=kitsu&id=' + kid)
        .catch(function () { return null; });
    var anidb = (d && typeof d.anidb === 'number') ? d.anidb : null;
    cachePut('ids', String(kid), { anidb: anidb });
    return anidb;
}

var toshoLast = 0;
async function animetoshoItems(aid) {
    var hit = cacheGet('tosho', String(aid));
    if (hit) return hit.titles;
    var wait = toshoLast + 600 - Date.now();
    if (wait > 0) await sleep(wait);
    toshoLast = Date.now();
    var d = await fetchJson('https://feed.animetosho.org/json?aid=' + aid);
    var titles = (Array.isArray(d) ? d : []).slice(0, 150).map(function (it) {
        return String(it.title || '') + ' | 👤 ' +
            (it.seeders == null ? '?' : it.seeders) + ' ⚙️ Animetosho';
    });
    cachePut('tosho', String(aid), { titles: titles });
    return titles;
}

async function auditEpisodeTosho(kitsuId, ep) {
    var sid = 'kitsu:' + kitsuId + ':' + ep;
    var aid = await kitsuToAnidb(kitsuId);
    var mapped = aid ? await mappedId(sid) : null; // only for the absolute number
    var abs = mapped ? await absoluteEpisode(mapped) : null;
    function finish(verdict, n, top) {
        return { ep: ep, sid: sid, route: 'animetosho', aid: aid, mappedId: mapped,
            abs: abs, verdict: verdict, streams: n, sample: top,
            oracle: torrentioOracle(sid, mapped) };
    }
    if (!aid) return finish('FAIL_NO_ANIDB_ID', 0, null);
    var items = await animetoshoItems(aid);
    var exp = { local: ep, mapped: null, abs: abs };
    var exact = [], batch = [];
    items.forEach(function (t) {
        var k = classifyTitle(t, exp);
        if (k === 'exact') exact.push(t);
        else if (k === 'batch') batch.push(t);
    });
    if (exact.length) return finish('PASS', exact.length, exact[0]);
    if (batch.length) return finish('PASS_BATCH', batch.length, batch[0]);
    return finish('FAIL_NOT_FOUND', 0, items[0] || null);
}

// ------------------------------------------------- episode-marker verification

function stripNoise(t) {
    return String(t || '')
        .replace(/[👤💾⚙].*$/u, ' ')                // torrentio seeders/size/provider suffix
        .replace(/\b\d{3,4}p\b/gi, ' ')             // 1080p / 720p
        .replace(/\b[xh]\.?26[45]\b/gi, ' ')
        .replace(/\b(?:10|8)[- ]?bit\b/gi, ' ')
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')        // years
        .replace(/\b[0-9a-f]{8}\b/gi, ' ')          // CRC tags
        .replace(/\b(?:aac|flac|opus|hevc|av1|web[- ]?dl|bdrip)\b/gi, ' ');
}

// exp = { local: N, mapped: {s, e} | null, abs: N | null }
// abs is the absolute episode number within the mapped standalone series:
// fansub groups often number that way (Feibanyama tags TYBW part 4 ep 1 as
// "S01E41"), so it counts as a correct identity alongside local and mapped.
function classifyTitle(raw, exp) {
    var t = stripNoise(raw);
    var found = [], m;
    function accepted(n) {
        return n === exp.local || (exp.mapped && n === exp.mapped.e) || (exp.abs && n === exp.abs);
    }
    var seRe = /S(\d{1,2})[\s._-]*E(\d{1,3})/gi;
    while ((m = seRe.exec(t))) {
        if (exp.mapped && +m[1] === exp.mapped.s && +m[2] === exp.mapped.e) return 'exact';
        found.push(+m[2]);
    }
    var rangeRe = /(?:^|[\s([])(\d{1,4})\s*[-~]\s*(\d{1,4})(?=$|[\s)\]])/g;
    while ((m = rangeRe.exec(t))) {
        var a = +m[1], b = +m[2];
        if (a < b && (exp.local >= a && exp.local <= b ||
            exp.mapped && exp.mapped.e >= a && exp.mapped.e <= b ||
            exp.abs && exp.abs >= a && exp.abs <= b)) return 'batch';
    }
    var epRe = /(?:\bE|\bEp\.?\s*|\bEpisode\s+|\s-\s)(\d{1,4})(?:v\d)?\b/gi;
    while ((m = epRe.exec(t))) found.push(+m[1]);
    if (found.some(accepted)) return 'exact';
    return found.length ? 'mismatch' : 'unknown';
}

function checkTitles(titles, exp) {
    var kinds = titles.map(function (t) { return classifyTitle(t, exp); });
    if (kinds.indexOf('exact') >= 0) return 'verified';
    if (kinds.indexOf('batch') >= 0) return 'batch';
    if (kinds.indexOf('mismatch') >= 0) return 'wrong-episode';
    return titles.length ? 'unverified' : 'none';
}

// -------------------------------------------------------------- per-show audit

function airedEpisodeNumbers(kitsuMeta, ani) {
    var vids = ((kitsuMeta || {}).videos || []).filter(function (v) {
        return /^kitsu:\d+:\d+$/.test(v.id || '');
    });
    var eps = vids.map(function (v) { return +v.id.split(':')[2]; })
        .filter(function (e) { return e >= 1; }).sort(function (a, b) { return a - b; });
    if (!eps.length) return [];
    var last = eps[eps.length - 1];
    if (ani.status === 'RELEASING' && ani.nextAiringEpisode && ani.nextAiringEpisode.episode > 1)
        last = Math.min(last, ani.nextAiringEpisode.episode - 1);
    return eps.filter(function (e) { return e <= last; });
}

function sampleEpisodes(eps) {
    if (EPISODES_MODE === 'all') return eps;
    var picks = {};
    EPISODES_MODE.split(',').forEach(function (mode) {
        if (mode === 'first' && eps.length) picks[eps[0]] = 1;
        if (mode === 'latest' && eps.length) picks[eps[eps.length - 1]] = 1;
    });
    return Object.keys(picks).map(Number).sort(function (a, b) { return a - b; });
}

// Absolute position of a tt<id>:<s>:<e> episode within its series (specials
// excluded), from Cinemeta's episode list via the production fetchSeriesMeta.
async function absoluteEpisode(mapped) {
    var meta = await addon.fetchSeriesMeta(mapped.split(':')[0]).catch(function () { return null; });
    var vids = ((meta || {}).videos || []).filter(function (v) {
        return /^tt\d+:\d+:\d+$/.test(v.id || '') && +v.id.split(':')[1] > 0;
    }).sort(function (a, b) {
        return +a.id.split(':')[1] - +b.id.split(':')[1] || +a.id.split(':')[2] - +b.id.split(':')[2];
    });
    var idx = vids.findIndex(function (v) { return v.id === mapped; });
    return idx >= 0 ? idx + 1 : null;
}

async function auditEpisode(kitsuId, ep) {
    var sid = 'kitsu:' + kitsuId + ':' + ep;
    var direct = await torrentioTitles(sid);
    var route = 'kitsu', titles = direct, mapped = null;
    if (!direct.length) {
        mapped = await mappedId(sid);
        if (mapped) {
            titles = await torrentioTitles(mapped);
            route = 'fallback';
        }
    }
    var expMapped = null, abs = null;
    if (route === 'fallback' && mapped) {
        var mm = /^tt\d+:(\d+):(\d+)$/.exec(mapped);
        if (mm) expMapped = { s: +mm[1], e: +mm[2] };
        abs = await absoluteEpisode(mapped);
    }
    var check = checkTitles(titles, { local: ep, mapped: expMapped, abs: abs });
    var verdict =
        check === 'none' ? (route === 'kitsu' && !mapped ? 'FAIL_NO_STREAMS_NO_MAPPING' : 'FAIL_NO_STREAMS') :
        check === 'wrong-episode' ? 'FAIL_WRONG_EPISODE' :
        check === 'unverified' ? 'WARN_UNVERIFIED' :
        check === 'batch' ? (route === 'kitsu' ? 'PASS_BATCH' : 'PASS_BATCH_FALLBACK') :
        route === 'kitsu' ? 'PASS' : 'PASS_FALLBACK';
    return { ep: ep, sid: sid, route: route, mappedId: mapped, verdict: verdict,
        streams: titles.length, sample: titles[0] || null };
}

var SEVERITY = ['PASS', 'PASS_FALLBACK', 'PASS_BATCH', 'PASS_BATCH_FALLBACK',
    'WARN_UNVERIFIED', 'WARN_AMBIGUOUS', 'WARN_RAW_ONLY', 'FAIL_NO_ANIDB_ID',
    'FAIL_NO_STREAMS_NO_MAPPING', 'FAIL_NO_STREAMS', 'FAIL_NOT_FOUND', 'FAIL_WRONG_EPISODE'];

async function auditShow(m, season) {
    var title = (m.title && (m.title.english || m.title.romaji)) || ('anilist:' + m.id);
    var result = { season: season.season + ' ' + season.year, title: title,
        anilistId: m.id, kitsuId: null, verdict: null, episodes: [] };
    try {
        var kid = await toKitsuId(m);
        if (!kid) { result.verdict = 'SKIP_NO_KITSU_ID'; return result; }
        result.kitsuId = kid;
        var meta = await addon.fetchSeriesMeta('kitsu:' + kid);
        var aired = airedEpisodeNumbers(meta, m);
        if (!aired.length) { result.verdict = 'SKIP_NOT_AIRED'; return result; }
        var names = [meta && meta.name, m.title && m.title.romaji, m.title && m.title.english]
            .concat((m.synonyms || []).slice(0, 4)) // fan short-names ("Hyakkano") live here
            .concat(((meta || {}).aliases || []).slice(0, 3)).filter(Boolean);
        for (var i = 0, eps = sampleEpisodes(aired); i < eps.length; i++)
            result.episodes.push(await (
                TARGET === 'nyaa' ? auditEpisodeNyaa(kid, eps[i], names) :
                TARGET === 'animetosho' ? auditEpisodeTosho(kid, eps[i]) :
                auditEpisode(kid, eps[i])));
        result.verdict = result.episodes.map(function (e) { return e.verdict; })
            .sort(function (a, b) { return SEVERITY.indexOf(b) - SEVERITY.indexOf(a); })[0];
    } catch (e) {
        result.verdict = 'ERROR';
        result.error = String(e && e.message || e);
    }
    var mark = /^PASS/.test(result.verdict) ? '✓' : /^SKIP/.test(result.verdict) ? '·' : '✗';
    process.stderr.write('  ' + mark + ' [' + result.season + '] ' + title + ' — ' + result.verdict + '\n');
    cacheFlush(); // persist per show so an interrupted run resumes, not restarts
    return result;
}

// --------------------------------------------------------------------- main

async function main() {
    var started = Date.now();
    var seasons = pastSeasons(SEASON_COUNT);
    console.log('Auditing seasons: ' + seasons.map(function (s) { return s.season + ' ' + s.year; }).join(', '));
    console.log(TARGET === 'nyaa'
        ? 'Target: nyaa.si RSS direct (cached Torrentio results used as oracle, no Torrentio calls)'
        : 'Torrentio: ' + TORRENTIO_HOST + (TORRENTIO_CONFIG ? ' (custom config)' : ' (public, no config)'));
    console.log('Episodes per show: ' + EPISODES_MODE + '\n');

    var work = [];
    for (var i = 0; i < seasons.length; i++) {
        var list = await fetchSeasonList(seasons[i]);
        if (FILTER) list = list.filter(function (m) {
            return JSON.stringify(m.title || {}).toLowerCase().indexOf(FILTER) >= 0;
        });
        list = list.slice(0, LIMIT);
        console.log(seasons[i].season + ' ' + seasons[i].year + ': ' + list.length + ' shows');
        list.forEach(function (m) { work.push({ m: m, season: seasons[i] }); });
    }
    console.log('\nTotal: ' + work.length + ' shows, concurrency ' + CONCURRENCY + '\n');

    var results = await mapLimit(work, CONCURRENCY, function (w) { return auditShow(w.m, w.season); });
    cacheFlush();

    var byVerdict = {};
    results.forEach(function (r) { byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1; });
    console.log('\n================ SUMMARY ================');
    Object.keys(byVerdict).sort().forEach(function (v) {
        console.log('  ' + v.padEnd(28) + byVerdict[v]);
    });
    var bad = results.filter(function (r) { return !/^(PASS|SKIP)/.test(r.verdict); });
    if (bad.length) {
        console.log('\n---------- needs attention (' + bad.length + ') ----------');
        bad.forEach(function (r) {
            console.log('\n' + r.title + '  [' + r.season + ']  kitsu:' + r.kitsuId + '  → ' + r.verdict);
            (r.episodes || []).forEach(function (e) {
                if (/^PASS/.test(e.verdict)) return;
                console.log('  ep ' + e.ep + ' (' + e.sid + ') via ' + e.route +
                    (e.mappedId ? ' → ' + e.mappedId : '') + ': ' + e.verdict +
                    ', ' + e.streams + ' streams' +
                    (e.oracle ? ' [torrentio oracle: ' + e.oracle + ']' : '') +
                    (e.query ? '\n    query: ' + e.query : '') +
                    (e.sample ? '\n    top: ' + e.sample : ''));
            });
            if (r.error) console.log('  error: ' + r.error);
        });
    }
    if (TARGET === 'nyaa') {
        var gaps = results.filter(function (r) {
            return (r.episodes || []).some(function (e) {
                return /^FAIL/.test(e.verdict) && e.oracle === 'had-streams';
            });
        });
        console.log('\nNyaa gaps (Torrentio verifiably had streams, our query found none): ' + gaps.length);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(REPORT_TARGET_FILE, JSON.stringify({
        generatedAt: new Date().toISOString(),
        seasons: seasons, episodesMode: EPISODES_MODE, target: TARGET,
        torrentio: { host: TORRENTIO_HOST, configured: !!TORRENTIO_CONFIG },
        summary: byVerdict, results: results
    }, null, 2));
    console.log('\nReport: ' + path.relative(process.cwd(), REPORT_TARGET_FILE));
    console.log('Done in ' + Math.round((Date.now() - started) / 1000) + 's — ' +
        results.filter(function (r) { return /^PASS/.test(r.verdict); }).length + '/' +
        results.filter(function (r) { return !/^SKIP/.test(r.verdict); }).length +
        ' auditable shows pass.');
    process.exitCode = bad.length ? 1 : 0;
}

main().catch(function (e) { console.error(e); cacheFlush(); process.exit(2); });
