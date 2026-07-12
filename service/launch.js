process.env.NODE_PATH = (process.env.NODE_PATH || '') + ':/usr/lib/node_modules:/usr/lib/nodejs';
require('module').Module._initPaths();
process.env.APP_PATH = process.env.APP_PATH || __dirname;

var http = require('http');
var fs = require('fs');
var path = require('path');
var Service = require('webos-service');
var anilistAddon = require('./anilist-addon.js');

var service = new Service('io.stremio.patched.server');
var ready = false;
var pendingMessages = [];

// Keep the service alive indefinitely
service.activityManager.create('keepAlive', function() {});

// Register the start method — responds once the HTTP server is listening
service.register('start', function(message) {
    if (ready) {
        message.respond({ ready: true });
    } else {
        pendingMessages.push(message);
    }
});

// Static file serving
var wwwDir = path.join(__dirname, 'www');

// ---- True ASS subtitle pipeline ---------------------------------------------
// Fansub MKVs carry full typeset ASS tracks + embedded fonts that the HLS
// pipeline flattens to WebVTT. These endpoints extract the real thing with the
// bundled ffmpeg so the page can render it via libass-wasm (SubtitlesOctopus):
//   /ass/probe?u=    -> { subs:[{index,lang,title,default}], fonts:[names] }
//   /ass/prepare?u=&idx= -> kicks font+track extraction; { ready, error }
//   /ass/file?u=&idx=    -> the extracted .ass
//   /ass/font?u=&f=      -> an extracted font file
// ffmpeg reads through /ass/proxy (plain-HTTP localhost) so the bundled binary
// never needs TLS; the proxy follows redirects and forwards Range requests.
var cp = require('child_process');
var crypto = require('crypto');
var ASSDIR = '/tmp/asscache';
try { fs.mkdirSync(ASSDIR); } catch (e) {}
var FF = path.join(__dirname, 'bin', 'ffmpeg');
var FFP = path.join(__dirname, 'bin', 'ffprobe');
var assProbe = {};   // key -> {status, data}
var assJobs = {};    // key-idx -> {status: pending|ready|error}
function assKey(u) { return crypto.createHash('sha1').update(u).digest('hex').slice(0, 16); }
function assProxyUrl(u) { return 'http://127.0.0.1:8081/ass/proxy?u=' + encodeURIComponent(u); }

function assProxyHandler(req, res) {
    var q = require('url').parse(req.url, true).query || {};
    var target = q.u;
    if (!target || !/^https?:\/\//.test(target)) { res.writeHead(400); return res.end(); }
    var redirects = 0;
    (function go(u) {
        var lib = /^https:/.test(u) ? require('https') : require('http');
        var pu = require('url').parse(u);
        var headers = {};
        if (req.headers.range) headers.Range = req.headers.range;
        var up = lib.get({ hostname: pu.hostname, port: pu.port, path: pu.path, headers: headers }, function (ur) {
            if (ur.statusCode >= 300 && ur.statusCode < 400 && ur.headers.location && redirects++ < 5) {
                ur.resume();
                return go(require('url').resolve(u, ur.headers.location));
            }
            var h = {};
            ['content-length', 'content-range', 'accept-ranges', 'content-type'].forEach(function (k) {
                if (ur.headers[k]) h[k] = ur.headers[k];
            });
            res.writeHead(ur.statusCode, h);
            ur.pipe(res);
        });
        up.on('error', function () { try { res.writeHead(502); res.end(); } catch (e) {} });
        req.on('close', function () { up.destroy(); });
    })(target);
}

function assProbeHandler(req, res) {
    var q = require('url').parse(req.url, true).query || {};
    var u = q.u;
    if (!u) { res.writeHead(400); return res.end('{}'); }
    var key = assKey(u);
    if (assProbe[key] && assProbe[key].status === 'ready') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(assProbe[key].data));
    }
    var out = '';
    var p = cp.spawn(FFP, ['-v', 'error', '-print_format', 'json', '-show_streams', assProxyUrl(u)]);
    p.stdout.on('data', function (d) { out += d; });
    var to = setTimeout(function () { try { p.kill(); } catch (e) {} }, 30000);
    p.on('close', function () {
        clearTimeout(to);
        var subs = [], fonts = [];
        try {
            (JSON.parse(out).streams || []).forEach(function (st) {
                var t = st.tags || {};
                if ('subtitle' === st.codec_type && /^(ass|ssa)$/.test(st.codec_name || ''))
                    subs.push({ index: st.index, lang: t.language || '', title: t.title || '',
                        def: (st.disposition || {}).default || 0 });
                if ('attachment' === st.codec_type && /\.(ttf|otf|ttc)$/i.test(t.filename || ''))
                    fonts.push(t.filename);
            });
        } catch (e) {}
        var data = { subs: subs, fonts: fonts };
        assProbe[key] = { status: 'ready', data: data };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    });
}

function assPrepareHandler(req, res) {
    var q = require('url').parse(req.url, true).query || {};
    var u = q.u, idx = parseInt(q.idx, 10);
    if (!u || isNaN(idx)) { res.writeHead(400); return res.end('{}'); }
    var key = assKey(u), jk = key + '-' + idx;
    var assFile = path.join(ASSDIR, jk + '.ass');
    var fontDir = path.join(ASSDIR, key + '-fonts');
    function respond() {
        var st = assJobs[jk] || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: 'ready' === st.status, error: 'error' === st.status }));
    }
    if (assJobs[jk]) return respond();
    if (fs.existsSync(assFile)) { assJobs[jk] = { status: 'ready' }; return respond(); }
    assJobs[jk] = { status: 'pending' };
    try { fs.mkdirSync(fontDir); } catch (e) {}
    // fonts: header-only read, quick
    var fj = cp.spawn(FF, ['-v', 'error', '-y', '-dump_attachment:t', '', '-i', assProxyUrl(u), '-t', '0', '-f', 'null', '-'], { cwd: fontDir });
    fj.on('error', function () {});
    // the track itself: full demux, minutes at worst
    var tmp = assFile + '.part';
    var ej = cp.spawn(FF, ['-v', 'error', '-y', '-i', assProxyUrl(u), '-map', '0:' + idx, '-c', 'copy', '-f', 'ass', tmp]);
    var eto = setTimeout(function () { try { ej.kill(); } catch (e) {} }, 10 * 60 * 1000);
    ej.on('close', function (code) {
        clearTimeout(eto);
        try {
            if (0 === code && fs.existsSync(tmp) && fs.statSync(tmp).size > 200) {
                fs.renameSync(tmp, assFile);
                assJobs[jk] = { status: 'ready' };
            } else assJobs[jk] = { status: 'error' };
        } catch (e) { assJobs[jk] = { status: 'error' }; }
    });
    ej.on('error', function () { assJobs[jk] = { status: 'error' }; });
    respond();
}

// ---- Downscaling image proxy -------------------------------------------------
// Full-size artwork (Kitsu originals, TVDB screencaps) is what lags the TV:
// decode + composite cost scales with pixels. /img?w=<width>&u=<url> serves the
// image resized via wsrv.nl (free resize CDN) and keeps a memory LRU so repeat
// renders never leave the device. On any failure it 302s to the original.
var IMG_WIDTHS = { '160': 1, '320': 1, '480': 1, '640': 1, '1280': 1 };
var imgCache = {}, imgOrder = [], imgBytes = 0;
function imgPut(k, buf, type) {
    if (imgCache[k]) return;
    imgCache[k] = { buf: buf, type: type || 'image/jpeg' };
    imgOrder.push(k); imgBytes += buf.length;
    while ((imgBytes > 24e6 || imgOrder.length > 300) && imgOrder.length) {
        var old = imgOrder.shift();
        if (imgCache[old]) { imgBytes -= imgCache[old].buf.length; delete imgCache[old]; }
    }
}
function imgFetch(u, w, cb) {
    var key = w + '|' + u;
    if (imgCache[key]) return cb(null, imgCache[key]);
    var https = require('https');
    var req = https.get({
        hostname: 'wsrv.nl',
        path: '/?url=' + encodeURIComponent(u) + '&w=' + w + '&q=72&output=jpg',
        headers: { 'User-Agent': 'Mozilla/5.0' }
    }, function (res) {
        if (res.statusCode !== 200) { res.resume(); return cb(new Error('wsrv ' + res.statusCode)); }
        var chunks = [];
        res.on('data', function (d) { chunks.push(d); });
        res.on('end', function () {
            var buf = Buffer.concat(chunks);
            imgPut(key, buf, res.headers['content-type']);
            cb(null, imgCache[key] || { buf: buf, type: res.headers['content-type'] || 'image/jpeg' });
        });
    });
    req.on('error', cb);
    req.setTimeout(12000, function () { req.destroy(new Error('img timeout')); });
}
// Background prefetch with small concurrency, to warm the cache before render.
function warmImages(urls, w) {
    var q = urls.slice(0, 120), act = 0;
    (function next() {
        while (act < 4 && q.length) {
            var u = q.shift();
            if (!u || imgCache[w + '|' + u]) continue;
            act++;
            imgFetch(u, w, function () { act--; next(); });
        }
    })();
}
var libraryCache = {}; // id -> removed
var clientLog = [];
var libraryAuthKey = null;
var libraryPullTimer = null;
var libraryItems = [];   // full items incl. watch state, for /library-next
var libraryPulledAt = 0;
function pullLibrary() {
    if (!libraryAuthKey) return Promise.resolve();
    return new Promise(function (resolve) {
        var https = require('https');
        var body = JSON.stringify({ authKey: libraryAuthKey, collection: 'libraryItem', all: true });
        var req = https.request({
            hostname: 'api.strem.io', path: '/api/datastoreGet', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, function (res) {
            var chunks = '';
            res.on('data', function (d) { chunks += d; });
            res.on('end', function () {
                try {
                    var items = (JSON.parse(chunks).result) || [];
                    libraryItems = items;
                    libraryPulledAt = Date.now();
                    libraryCache = {};
                    items.forEach(function (it) { if (it && it._id) libraryCache[it._id] = !!it.removed; });
                } catch (e) {}
                resolve();
            });
        });
        req.on('error', function () { resolve(); });
        req.setTimeout(15000, function () { req.destroy(); resolve(); });
        req.write(body); req.end();
    });
}
function schedulePull(delayMs) {
    clearTimeout(libraryPullTimer);
    libraryPullTimer = setTimeout(pullLibrary, delayMs);
}
setInterval(pullLibrary, 10 * 60 * 1000);
var mimeTypes = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon', '.gif': 'image/gif', '.webp': 'image/webp',
    '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.json': 'application/json',
    '.map': 'application/json', '.txt': 'text/plain', '.mp3': 'audio/mpeg'
};

function serveStatic(urlPath, res, next) {
    // Reject path traversal
    var filePath = path.join(wwwDir, urlPath === '/' ? 'index.html' : urlPath);
    if (filePath.indexOf(wwwDir) !== 0) return next();

    fs.stat(filePath, function(err, stat) {
        if (err || !stat.isFile()) return next();
        var ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        var stream = fs.createReadStream(filePath);
        stream.on('error', function() { try { res.end(); } catch (_) {} });
        stream.pipe(res);
    });
}

function proxyToStreaming(req, res) {
    var opts = { hostname: '127.0.0.1', port: 11470, path: req.url, method: req.method, headers: req.headers };
    var proxy = http.request(opts, function(proxyRes) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });
    proxy.on('error', function() { res.writeHead(502); res.end(); });
    req.pipe(proxy);
}

// A leftover Service Worker (Vidaa 'stremio-vidaa-v10') can get stuck
// controlling the page and serve stale cached chunks, masking every update.
// Serve a self-destructing SW at /sw.js: the browser re-fetches this script
// on each navigation (bypassing the SW), and on activate it purges all
// caches, unregisters itself, and reloads every client to fresh assets.
var SELF_DESTRUCT_SW = [
    "self.addEventListener('install', function(){ self.skipWaiting(); });",
    "self.addEventListener('activate', function(e){",
    "  e.waitUntil(",
    "    caches.keys().then(function(ks){ return Promise.all(ks.map(function(k){ return caches.delete(k); })); })",
    "    .then(function(){ return self.registration.unregister(); })",
    "    .then(function(){ return self.clients.matchAll({ type: 'window' }); })",
    "    .then(function(cs){ cs.forEach(function(c){ try { c.navigate(c.url); } catch (_) {} }); })",
    "  );",
    "});"
].join("\n");

// Meta-enrichment interceptor, injected into the core's Web Worker (and the
// page) at serve time. Kitsu's per-season meta entries are the right SHAPE
// (one page per season, matching the Anime tab), but their episode lists are
// bare for airing shows. AIOMetadata has per-episode overviews/thumbnails/
// titles and uses the SAME kitsu:<id>:<ep> video ids, so responses from the
// Kitsu addon get episodes enriched in-flight, matched strictly by video id.
var FETCH_INTERCEPT = [
    "(function(){",
    "  var AIO='https://aiometadatafortheweebs.midnightignite.me/stremio/e403afb8-02d5-416e-b520-6b9bb80e8e2f';",
    "  var g=(typeof self!=='undefined')?self:window;",
    "  if(!g.fetch||g.__kitsuEnrich)return; g.__kitsuEnrich=1;",
    "  var of=g.fetch.bind(g);",
    "  var mergedCache={};",
    "  g.fetch=function(input,init){",
    "    var url=(typeof input==='string')?input:((input&&input.url)||'');",
    "    if(/aiometadatafortheweebs/.test(url)&&/\\/meta\\/(?:series|anime)\\/kitsu(?::|%3A)/i.test(url)){",
    "      return Promise.resolve(new Response('{\"meta\":null}',{status:404,headers:{'Content-Type':'application/json'}}));",
    "    }",
    "    var m=/anime-kitsu\\.strem\\.fun\\/meta\\/(?:series|anime)\\/(kitsu(?::|%3A)\\d+)\\.json/i.exec(url);",
    "    if(!m||g.__mergeOff)return of(input,init);",
    "    var kid;try{kid=decodeURIComponent(m[1]);}catch(e){kid=m[1];}",
    "    var hit=mergedCache[kid];",
    "    if(hit&&(Date.now()-hit.at)<6e5)return Promise.resolve(new Response(hit.body,{status:200,headers:{'Content-Type':'application/json'}}));",
    "    var aiop=of(AIO+'/meta/series/'+encodeURIComponent(kid)+'.json')",
    "      .then(function(r){return r.ok?r.json():null;}).catch(function(){return null;});",
    "    return Promise.all([of(input,init),aiop]).then(function(rs){",
    "      var kres=rs[0],aio=rs[1];",
    "      if(!aio||!aio.meta||!kres.ok)return kres;",
    "      return kres.json().then(function(kd){",
    "        var vids=(kd.meta&&kd.meta.videos)||[],byId={};",
    "        ((aio.meta.videos)||[]).forEach(function(v){byId[v.id]=v;});",
    "        vids.forEach(function(v){",
    "          var e=byId[v.id]; if(!e)return;",
    "          var ov=e.overview||e.description;",
    "          if(!v.overview&&ov){v.overview=ov;v.description=ov;}",
    "          if(!v.thumbnail&&e.thumbnail)v.thumbnail=e.thumbnail;",
    "          if(e.released){v.released=e.released;v.__aio=1;}",
    "          if(e.title&&!/^Episode \\d+$/i.test(e.title)&&(!v.title||/^Episode \\d+$/i.test(v.title)))v.title=e.title;",
    "        });",
    "        var fbThumb=(kd.meta&&(kd.meta.background||kd.meta.poster))||null;",
    "        if(fbThumb)vids.forEach(function(v){if(!v.thumbnail)v.thumbnail=fbThumb;});",
    "        var needSched=vids.some(function(v){return !v.__aio&&vids.length>1;});",
    "        var uniq={};vids.forEach(function(v){if(v.released)uniq[v.released]=1;});",
    "        var done=function(){",
    "          vids.forEach(function(v){delete v.__aio;});",
    "          var PX='http://127.0.0.1:8081/img?';",
    "          vids.forEach(function(v){if(v.thumbnail&&v.thumbnail.indexOf('/img?')<0)v.thumbnail=PX+'w=320&u='+encodeURIComponent(v.thumbnail);});",
    "          if(kd.meta&&kd.meta.background&&kd.meta.background.indexOf('/img?')<0)kd.meta.background=PX+'w=1280&u='+encodeURIComponent(kd.meta.background);",
    "          vids.slice(0,40).forEach(function(v){if(v.thumbnail)of(v.thumbnail).catch(function(){});});",
    "          var body=JSON.stringify(kd);",
    "          mergedCache[kid]={at:Date.now(),body:body};",
    "          return new Response(body,{status:200,headers:{'Content-Type':'application/json'}});",
    "        };",
    "        if(!needSched&&Object.keys(uniq).length>1)return done();",
    "        var num=(kid.split(':')[1]||'');",
    "        return of('http://127.0.0.1:8081/anime-airing/schedule/'+num+'.json')",
    "          .then(function(r){return r.ok?r.json():{};}).catch(function(){return {};})",
    "          .then(function(sched){",
    "            vids.forEach(function(v){",
    "              if(v.__aio)return;",
    "              var ep=parseInt(String(v.id||'').split(':').pop(),10);",
    "              if(sched[ep])v.released=sched[ep];",
    "            });",
    "            return done();",
    "          });",
    "      }).catch(function(){return of(input,init);});",
    "    });",
    "  };",
    "})();\n"
].join("\n");

// Warm the proxy cache for every /img reference in a JSON body we just served,
// so posters/stills are resized+cached before the TV asks for them.
function warmFromBody(body) {
    try {
        var ms = String(body).match(/\/img\?w=(\d+)&u=([^"\\]+)/g) || [];
        var by = {};
        ms.forEach(function (m) {
            var mm = /w=(\d+)&u=(.+)$/.exec(m);
            if (!mm) return;
            try { (by[mm[1]] = by[mm[1]] || []).push(decodeURIComponent(mm[2])); } catch (e) {}
        });
        Object.keys(by).forEach(function (w) { warmImages(by[w], w); });
    } catch (e) {}
}

// Single server: static files first, then proxy to streaming server
http.createServer(function(req, res) {
    var urlPath = req.url.split('?')[0];
    // In-process AniList "currently airing" catalog addon (served to Stremio
    // as http://127.0.0.1:8081/anime-airing/...). CORS + JSON per addon spec.
    if (urlPath.indexOf('/anime-airing/') === 0) {
        var pr = anilistAddon.handle(urlPath);
        if (pr) {
            pr.then(function(r) {
                res.writeHead(r.status, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                    'Cache-Control': 'no-cache'
                });
                res.end(r.body);
                warmFromBody(r.body);
            }).catch(function() { res.writeHead(500); res.end('{}'); });
            return;
        }
    }
    if (urlPath === '/client-log') {
        if (req.method === 'POST') {
            var clB = '';
            req.on('data', function (d) { clB += d; });
            req.on('end', function () {
                clientLog.push(new Date().toISOString() + ' ' + clB);
                if (clientLog.length > 300) clientLog.shift();
                res.writeHead(204); res.end();
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(clientLog.join('\n'));
        return;
    }
    if (urlPath === '/ass/proxy') return assProxyHandler(req, res);
    if (urlPath === '/ass/probe') return assProbeHandler(req, res);
    if (urlPath === '/ass/prepare') return assPrepareHandler(req, res);
    if (urlPath === '/ass/file') {
        var afq = require('url').parse(req.url, true).query || {};
        var af = path.join(ASSDIR, assKey(afq.u || '') + '-' + parseInt(afq.idx, 10) + '.ass');
        return fs.readFile(af, function (err, buf) {
            if (err) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(buf);
        });
    }
    if (urlPath === '/ass/font') {
        var fq = require('url').parse(req.url, true).query || {};
        var ff = path.join(ASSDIR, assKey(fq.u || '') + '-fonts', path.basename(fq.f || ''));
        return fs.readFile(ff, function (err, buf) {
            if (err) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'font/ttf', 'Cache-Control': 'max-age=86400' });
            res.end(buf);
        });
    }
    if (urlPath.indexOf('/octopus/') === 0) {
        var of_ = path.join(__dirname, 'octopus', path.basename(urlPath));
        return fs.readFile(of_, function (err, buf) {
            if (err) { res.writeHead(404); return res.end(); }
            var ot = /\.wasm$/.test(of_) ? 'application/wasm' : (/\.woff2$/.test(of_) ? 'font/woff2' : 'application/javascript');
            res.writeHead(200, { 'Content-Type': ot, 'Cache-Control': 'max-age=86400' });
            res.end(buf);
        });
    }
    if (urlPath === '/img') {
        var iq = require('url').parse(req.url, true).query || {};
        var iu = iq.u, iw = IMG_WIDTHS[iq.w] ? iq.w : '320';
        if (!iu || !/^https?:\/\//.test(iu)) { res.writeHead(400); return res.end(); }
        imgFetch(iu, iw, function (err, hit) {
            if (err || !hit) { res.writeHead(302, { Location: iu }); return res.end(); }
            res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'max-age=86400' });
            res.end(hit.buf);
        });
        return;
    }
    if (urlPath === '/library-next') {
        // "Next Up" home row: last-interacted library series with the episode
        // to continue (progress) or watch next, sorted by newest aired episode.
        var force = req.url.indexOf('fresh=1') >= 0;
        var freshP = (force || Date.now() - libraryPulledAt > 60000) ? pullLibrary() : Promise.resolve();
        freshP.then(function () {
            return anilistAddon.buildNextUp(libraryItems);
        }).then(function (metas) {
            var lnBody = JSON.stringify({ metas: metas });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(lnBody);
            warmFromBody(lnBody);
        }).catch(function () { res.writeHead(500); res.end('{"metas":[]}'); });
        return;
    }
    if (urlPath === '/library-cache') {
        // Passive mirror of the account library, fed by the worker fetch
        // interceptor teeing the app's own datastore sync traffic.
        if (req.method === 'POST') {
            var lcBody = '';
            req.on('data', function (d) { lcBody += d; });
            req.on('end', function () {
                try {
                    var msg = JSON.parse(lcBody);
                    if (msg.authKey && msg.authKey !== libraryAuthKey) { libraryAuthKey = msg.authKey; schedulePull(500); }
                    if (msg.full) { libraryCache = {}; msg.full.forEach(function (e) { libraryCache[e.id] = !!e.removed; }); }
                    if (msg.upsert) { msg.upsert.forEach(function (e) { libraryCache[e.id] = !!e.removed; }); schedulePull(3000); }
                } catch (e) {}
                res.writeHead(204); res.end();
            });
            return;
        }
        var ids = Object.keys(libraryCache).filter(function (k) { return !libraryCache[k]; });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ ids: ids }));
        return;
    }
    if (urlPath === '/anime-search') {
        // Paginating anime search (AniList -> kitsu ids). Query: ?q=&page=
        var q = require('url').parse(req.url, true).query || {};
        anilistAddon.search(q.q, q.page).then(function (r) {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache'
            });
            res.end(JSON.stringify(r));
        }).catch(function () { res.writeHead(500); res.end('{"metas":[],"hasNext":false}'); });
        return;
    }
    if (urlPath === '/v5-worker.js') {
        // Prepend the fetch interceptor so core-in-worker addon requests are enriched.
        return fs.readFile(path.join(wwwDir, 'v5-worker.js'), function(err, buf) {
            if (err) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
            res.end(FETCH_INTERCEPT + buf.toString());
        });
    }
    if (urlPath === '/anime.html') {
        return fs.readFile(path.join(__dirname, 'anime.html'), function(err, buf) {
            if (err) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
            res.end(buf);
        });
    }
    if (urlPath === '/sw.js') {
        res.writeHead(200, {
            'Content-Type': 'application/javascript',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(SELF_DESTRUCT_SW);
        return;
    }
    if (urlPath === '/' || urlPath === '/index.html') {
        var idx = path.join(wwwDir, 'index.html');
        return fs.readFile(idx, function(err, buf) {
            if (err) return proxyToStreaming(req, res);
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
            // Inject the same fetch interceptor for main-thread requests.
            var html = buf.toString().replace('<head>', '<head>\n    <script>' + FETCH_INTERCEPT + '</script>');
            res.end(html);
        });
    }
    serveStatic(urlPath, res, function() { proxyToStreaming(req, res); });
}).listen(8081, function() {
    ready = true;
    // Respond to any start calls that arrived before the server was ready
    pendingMessages.forEach(function(msg) { msg.respond({ ready: true }); });
    pendingMessages = [];
});

// Point the streaming server at the bundled ffmpeg binaries.
// HLS remux/transcode requires ffmpeg+ffprobe; without these the streaming
// server's /hlsv2/* endpoints return 500 "no ffmpeg found".
process.env.FFMPEG_BIN = path.join(__dirname, 'bin', 'ffmpeg');
process.env.FFPROBE_BIN = path.join(__dirname, 'bin', 'ffprobe');

// The Stremio streaming server binds 11470. If another Stremio instance
// (e.g. the original app) already has it up, reuse it instead of crashing
// on EADDRINUSE — the proxy above targets 11470 regardless of who started it.
var net = require('net');
var probe = new net.Socket();
var decided = false;
function startOwn() { if (!decided) { decided = true; require('./server.js'); } }
probe.setTimeout(1200);
probe.once('connect', function() { decided = true; probe.destroy(); }); // already running, reuse
probe.once('timeout', function() { probe.destroy(); startOwn(); });
probe.once('error', function() { startOwn(); });
probe.connect(11470, '127.0.0.1');
