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
    "  g.fetch=function(input,init){",
    "    var url=(typeof input==='string')?input:((input&&input.url)||'');",
    "    var m=/anime-kitsu\\.strem\\.fun\\/meta\\/(?:series|anime)\\/(kitsu(?::|%3A)\\d+)\\.json/i.exec(url);",
    "    if(!m)return of(input,init);",
    "    var kid;try{kid=decodeURIComponent(m[1]);}catch(e){kid=m[1];}",
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
    "          if(e.title&&!/^Episode \\d+$/i.test(e.title)&&(!v.title||/^Episode \\d+$/i.test(v.title)))v.title=e.title;",
    "        });",
    "        return new Response(JSON.stringify(kd),{status:200,headers:{'Content-Type':'application/json'}});",
    "      }).catch(function(){return of(input,init);});",
    "    });",
    "  };",
    "})();\n"
].join("\n");

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
            }).catch(function() { res.writeHead(500); res.end('{}'); });
            return;
        }
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
