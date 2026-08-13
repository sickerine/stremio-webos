(function (root) {
    'use strict';

    var PLATFORM_RE = /(?:^|[^a-z0-9])(cr|dsnp|amzn|nf|bili|bsite|iqiyi|hulu|hidive)(?:[^a-z0-9]|$)/i;
    var REDIRECT_RE = /↗\s*plays\s+(v\d+|repack\d*)/i;

    function text(stream) {
        return ((stream && stream.title) || '') + '\n' +
            ((stream && stream.description) || '') + '\n' + ((stream && stream.name) || '');
    }

    function normalized(value) {
        return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    function actualRevision(value) {
        value = String(value || '').replace(/^.*↗\s*plays\s+.*$/gim, '');
        var numeric = /\b(?:s\d{1,2}e\d{1,4}|e\d{1,4}|\d{1,4})v(\d{1,2})\b/i.exec(value) ||
            /(?:^|[^a-z0-9])v(\d{1,2})(?:[^a-z0-9]|$)/i.exec(value);
        if (numeric && +numeric[1] >= 2)
            return { label: 'V' + +numeric[1], number: +numeric[1], repack: false };
        var repack = /(?:^|[^a-z0-9])repack(\d*)(?:[^a-z0-9]|$)/i.exec(value);
        return repack ? { label: 'REPACK' + (repack[1] || ''), number: null, repack: true } : null;
    }

    function group(value) {
        var matches = String(value || '').match(/(?:^|\n)\s*\[([^\]]+)]/g) || [];
        for (var i = 0; i < matches.length; i++) {
            var match = /\[([^\]]+)]/.exec(matches[i]);
            var candidate = normalized(match && match[1]);
            if (candidate && !/^(?:tb|tb download|rd|batch)(?:\s|$)/.test(candidate)) return candidate;
        }
        var lines = String(value || '').split('\n');
        for (var j = 0; j < lines.length; j++) {
            var withoutTags = lines[j].replace(
                /(?:\s*(?:\([^()]*\)|\[[^\[\]]*]))+\s*$/g, '',
            );
            var suffix = /-([a-z0-9][a-z0-9._-]{1,30})$/i.exec(withoutTags);
            if (suffix && !/^(?:dl|rip|web|h?26[45]|x26[45]|avc|hevc|av1)$/i.test(suffix[1]))
                return normalized(suffix[1]);
        }
        return '';
    }

    function resolution(value) {
        var match = /(?:^|[^a-z0-9])(2160p|4k|uhd|1080p|720p|480p)(?:[^a-z0-9]|$)/i.exec(value);
        if (!match) return '';
        return /^(?:2160p|4k|uhd)$/i.test(match[1]) ? '2160p' : match[1].toLowerCase();
    }

    function source(value) {
        if (/\bweb[ ._-]?dl\b/i.test(value)) return 'web-dl';
        if (/\bweb[ ._-]?rip\b/i.test(value)) return 'webrip';
        if (/\b(?:bd(?:rip|mv)?|blu[ ._-]?ray|jpbd)\b/i.test(value)) return 'bd';
        if (/\bremux\b/i.test(value)) return 'remux';
        return '';
    }

    function codec(value) {
        if (/(?:^|[^a-z0-9])av1(?:[^a-z0-9]|$)/i.test(value)) return 'av1';
        if (/\b(?:hevc|x265|h[ ._-]?265)\b/i.test(value)) return 'hevc';
        if (/\b(?:avc|x264|h[ ._-]?264)\b/i.test(value)) return 'avc';
        return '';
    }

    function bitDepth(value) {
        var match = /(?:^|[^a-z0-9])(8|10|12)[ ._-]?bit(?:[^a-z0-9]|$)/i.exec(value);
        return match ? match[1] : '';
    }

    function platform(value) {
        var match = PLATFORM_RE.exec(value);
        return match ? match[1].toLowerCase() : '';
    }

    function episode(value) {
        var match = /\bs\d{1,2}e(\d{1,4})\b/i.exec(value) || /\be(\d{1,4})(?:v\d+)?\b/i.exec(value) ||
            /(?:^|\s)-\s*0*(\d{1,4})(?:v\d+)?(?:\s|\(|\[|$)/im.exec(value);
        return match ? String(+match[1]) : '';
    }

    function audio(value) {
        if (/\bmulti(?:[ ._-]?audio)?\b/i.test(value)) return 'multi';
        if (/\bdual(?:[ ._-]?audio)?\b/i.test(value)) return 'dual';
        if (/\b(?:dub|dubbed|english dub)\b/i.test(value)) return 'dub';
        return '';
    }

    function sameWhenKnown(a, b) {
        return !a || !b || a === b;
    }

    function audioCompatible(base, candidate) {
        if (!base) return true;
        if (base === 'multi') return candidate === 'multi';
        if (base === 'dual') return candidate === 'dual' || candidate === 'multi';
        if (base === 'dub') return candidate === 'dub' || candidate === 'dual' || candidate === 'multi';
        return true;
    }

    function fingerprint(stream) {
        var value = text(stream);
        return {
            value: value,
            group: group(value),
            resolution: resolution(value),
            source: source(value),
            codec: codec(value),
            bitDepth: bitDepth(value),
            platform: platform(value),
            episode: episode(value),
            audio: audio(value),
            batch: /(?:^|[^a-z0-9])batch(?:[^a-z0-9]|$)/i.test(value),
            bd: /\b(?:bd(?:rip|mv)?|blu[ ._-]?ray|jpbd|remux)\b/i.test(value),
            remux: /\bremux\b/i.test(value),
            hdr: /\b(?:hdr10\+?|hdr|dolby[ ._-]?vision|dv)\b/i.test(value),
            uncensored: /\buncensored\b/i.test(value),
        };
    }

    function sameLineage(base, candidate) {
        if (!base.group || base.group !== candidate.group) return false;
        if (!base.resolution || base.resolution !== candidate.resolution) return false;
        if (base.batch !== candidate.batch || base.bd !== candidate.bd || base.remux !== candidate.remux ||
            base.hdr !== candidate.hdr ||
            base.uncensored !== candidate.uncensored) return false;
        if (!sameWhenKnown(base.source, candidate.source) || !sameWhenKnown(base.codec, candidate.codec) ||
            !sameWhenKnown(base.bitDepth, candidate.bitDepth) ||
            !sameWhenKnown(base.platform, candidate.platform) ||
            !sameWhenKnown(base.episode, candidate.episode)) return false;
        return audioCompatible(base.audio, candidate.audio);
    }

    function newestCandidate(base, candidates) {
        var baseRevision = actualRevision(base.fp.value);
        var matches = candidates.filter(function (candidate) {
            if (candidate.stream === base.stream || !candidate.revision ||
                !candidate.stream.deepLinks || !candidate.stream.deepLinks.player ||
                !sameLineage(base.fp, candidate.fp)) return false;
            if (baseRevision && baseRevision.number && candidate.revision.number)
                return candidate.revision.number > baseRevision.number;
            return !baseRevision || !baseRevision.repack;
        });
        matches.sort(function (a, b) {
            var an = a.revision.number || 0, bn = b.revision.number || 0;
            return bn - an;
        });
        return matches[0] || null;
    }

    root.__linkLatestStreamRevisions = function (streams) {
        if (!streams || !streams.length) return streams || [];
        var candidates = streams.map(function (stream) {
            var fp = fingerprint(stream);
            return { stream: stream, fp: fp, revision: actualRevision(fp.value) };
        });
        return candidates.map(function (base) {
            var existing = REDIRECT_RE.exec(base.fp.value);
            if (existing) return Object.assign({}, base.stream, {
                __revisionRedirect: existing[1].toUpperCase(),
            });
            var latest = newestCandidate(base, candidates);
            if (!latest) return base.stream;
            return Object.assign({}, base.stream, {
                deepLinks: Object.assign({}, base.stream.deepLinks, {
                    player: latest.stream.deepLinks.player,
                }),
                __revisionRedirect: latest.revision.label,
            });
        });
    };
})(window);
