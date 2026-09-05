// Release-text classifiers behind the stream-list chips. Pure functions over the
// stream's visible text (title + description + name), shared by the TV page
// (window.StreamFilters) and the tests (module.exports). ES5: runs on webOS.
//
//   anime pages      : All | Seasonal | BD          (isSeasonal / isBD)
//   everything else  : All | Supported | Unsupported (support -> can THIS TV play it)
//
// "Supported" is about what LG's web-app media pipeline decodes: Dolby Digital
// and Plus, AAC, FLAC, Opus, Vorbis, MP3, PCM. DTS in every flavour and TrueHD
// are silent (LG dropped the DTS licence in 2020 and never exposed TrueHD to web
// apps; measured on the C5 via mediaCapabilities). 10-bit H.264 (Hi10P) has no
// hardware decoder on any TV. A release that names no codec is "unknown" and
// stays visible under Supported: hiding on a guess is worse than a silent pick.
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.StreamFilters = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function text(s) {
        return ((s && (s.title || '')) + '\n' + (s && (s.description || '')) + '\n' + (s && (s.name || '')));
    }

    // ---- source -------------------------------------------------------------
    // Blu-ray sourced: BD, BDRip, BDMV, BDRemux (one word or split), BDR, BRRip,
    // BluRay/Blu-ray, Remux, JPBD/USBD. Token must start after a non-alphanumeric
    // and end before a letter-free boundary (digits allowed: BD1080p).
    // Blu-ray/BluRay may be glued to a word (FullBluRay); the short tokens may not.
    var BD_RE = /(^|[^a-z0-9])(bd(-?(rips?|mv|remux|mux|r|iso|box))?|remux|(jp|us|it|eu|de|fr|ger|uk)bd|brrip)(?=[^a-z]|$)|blu-?ray/i;
    function isBD(t) { return BD_RE.test(t || ''); }

    // Simulcast / web releases: known fansub+rip groups (bracketed at the start of
    // a line, as Nyaa names them), a few groups that appear inline, or a web
    // source tag. Anything Blu-ray-marked is never seasonal.
    // Web encoders (Judas, EMBER, Sokudo, Breeze, Cleo, ...) also publish BD batches;
    // the BD check above runs first, so only their web releases land here.
    var GROUPS = ['subsplease', 'erai-raws', 'erai raws', 'judas', 'asw', 'yameii', 'toonshub', 'dkb', 'anime time',
        'horriblesubs', 'ember', 'asakura', 'ironclad', 'feibanyama', 'nc-raws', 'ohys-raws', 'lazy', 'cr-raws',
        'sokudo', 'breeze', 'cleo', 'arg0', 'doomdos', 'dubs-empire'];
    var INLINE = ['varyg', 'tsundere-raws', 'tsundere raws'];
    // Unambiguous web-source tags anywhere; the bare tokens WEB / CR / NF only when
    // glued to a resolution, codec, other tag or bracket ("Charlotte's Web 2006" is a title).
    var WEB_TAG_RE = /(^|[^a-z0-9])(web-?dl|web-?rip|webmux|crunchyroll|hidive|amzn|dsnp|netflix|b-?global|bilibili|bili|funimation|adn|hulu|hmax|atvp|pcok|itunes)(?=[^a-z]|$)/i;
    var WEB_BARE_RE = /(^|[^a-z0-9])(web|cr|nf)(?=[ ._-]*(\d{3,4}[pi](?![a-z])|x26[45]|h\.?26[45]|av1|vp9|hevc|avc|aac|opus|flac|ddp?a?(?![a-z])|dd\+|e?ac-?3|dolby|atmos|dl(?![a-z])|rip(?![a-z])|web(?![a-z])|cr(?![a-z])|\]|\)))/i;
    var WEB_AFTER_RES_RE = /(\d{3,4}[pi]|x26[45]|h\.?26[45]|hevc|avc|av1)[ ._-]*(web|cr|nf)(?![a-z])/i;   // "1080p WEB", "x265 NF"
    var WEB_RE = { test: function (t) { return WEB_TAG_RE.test(t) || WEB_BARE_RE.test(t) || WEB_AFTER_RES_RE.test(t); } };
    function isSeasonal(t) {
        t = t || '';
        if (isBD(t)) return false;
        var tl = t.toLowerCase();
        var lines = tl.split('\n');
        for (var k = 0; k < lines.length; k++) {
            var m = lines[k].trim().match(/^\[([^\]]+)\]/);
            if (m) { for (var i = 0; i < GROUPS.length; i++) if (m[1].indexOf(GROUPS[i]) === 0) return true; }
        }
        for (var j = 0; j < INLINE.length; j++) if (tl.indexOf(INLINE[j]) >= 0) return true;
        return WEB_RE.test(t);
    }

    // ---- playability on this TV --------------------------------------------
    // A digit may follow a codec token (DDP5.1, AAC2.0, DTS5.1, TrueHD7.1).
    var AUDIO_OK = /(^|[^a-z0-9])(ddpa?|dd\+|dd|e[ ._-]?ac[ ._-]?3|eac3|ac[ ._-]?3|dolby[ ._-]?digital([ ._-]?plus)?|he-?aac|aac|flac|opus|vorbis|mp3|l?pcm)(?=[^a-z]|$)/i;
    // A codec-looking word directly followed by a release year is a title ("Opus (2025)",
    // "Mr Hollands Opus 1995"), not a track. Blank it before looking for codecs.
    var TITLE_WORD_RE = /(^|[^a-z0-9])(opus|flac|aac|pcm|mp3|dd|dts|atmos)(?=[ ._(-]*(19|20)\d\d(?!\d))/ig;
    function stripTitleWords(t) { return String(t || '').replace(TITLE_WORD_RE, '$1'); }
    // DTSD = German scene tag for a DTS German dub; still DTS.
    var AUDIO_NO = /(^|[^a-z0-9])(dts(-?(hd|x|es|ma|hdma|hd[ ._-]?ma|d))?|dts[ ._:-]?x|true-?hd)(?=[^a-z]|$)/i;
    var ATMOS_RE = /(^|[^a-z0-9])atmos(?=[^a-z]|$)/i;
    var TRUEHD_RE = /true-?hd/i;
    // Only 10-bit H.264 is a problem; x265 10-bit is standard HDR and fine.
    var VIDEO_NO = /(^|[^a-z0-9])(hi10p?|hi444pp?|10-?bits?[ ._-]?(x264|h\.?264|avc)|(x264|h\.?264|avc)[ ._-]?10-?bits?)(?=[^a-z]|$)/i;

    // -> 'supported' | 'unsupported' | 'unknown'
    function audioSupport(t) {
        t = stripTitleWords(t);
        var ok = AUDIO_OK.test(t);
        // "Atmos" with no carrier named: TrueHD on disc/remux releases (silent), Dolby
        // Digital Plus on web releases (fine), and honestly unknown when the source
        // is not stated either (fan regrades, "Open Matte" cuts).
        if (!ok && ATMOS_RE.test(t) && !TRUEHD_RE.test(t)) {
            if (isBD(t)) return 'unsupported';
            if (WEB_RE.test(t)) ok = true; else if (!AUDIO_NO.test(t)) return 'unknown';
        }
        var no = AUDIO_NO.test(t);
        if (no && !ok) return 'unsupported';
        if (ok) return 'supported';
        return 'unknown';
    }
    function videoSupport(t) { return VIDEO_NO.test(t || '') ? 'unsupported' : 'unknown'; }
    function support(t) {
        if (videoSupport(t) === 'unsupported') return 'unsupported';
        return audioSupport(t);
    }

    // ---- chip plumbing ------------------------------------------------------
    function filterByKind(streams, kind, anime) {
        if (!streams || !streams.length) return streams;
        if (anime) {
            if (kind === 'bd') return streams.filter(function (s) { return isBD(text(s)); });
            if (kind === 'seasonal') return streams.filter(function (s) { return isSeasonal(text(s)); });
            return streams;
        }
        if (kind === 'unsupported') return streams.filter(function (s) { return support(text(s)) === 'unsupported'; });
        if (kind === 'supported') return streams.filter(function (s) { return support(text(s)) !== 'unsupported'; });
        return streams;
    }
    function kindOptions(anime, kind) {
        var opts = anime ? [['all', 'All'], ['seasonal', 'Seasonal'], ['bd', 'BD']]
                         : [['all', 'All'], ['supported', 'Supported'], ['unsupported', 'Unsupported']];
        return opts.map(function (o) { return { value: o[0], label: o[1], selected: o[0] === kind }; });
    }

    return { text: text, isBD: isBD, isSeasonal: isSeasonal, audioSupport: audioSupport, videoSupport: videoSupport,
             support: support, filterByKind: filterByKind, kindOptions: kindOptions, defaultKind: function (anime) { return anime ? 'all' : 'supported'; } };
}));
