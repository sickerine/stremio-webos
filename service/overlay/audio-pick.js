// Which embedded audio track should the TV start with? Pure function, shared by the
// player patch (window.AudioPick) and vactest/test-audio-pick.js (module.exports).
//
// The native webOS audioTracks list carries only language + (often empty) label, and
// lists tracks in Luna order. The first English track on a Blu-ray is frequently the
// director's commentary (it comes first on the disc), which is how "I'm hearing the
// commentary" happens. So: among tracks in the wanted language set, skip commentary /
// audio-description labels when any alternative exists; otherwise fall back to the
// first language match; otherwise -1 (caller keeps the player's default).
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.AudioPick = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    var SKIP_RE = /commentar|director|audio[ -]?descri|descriptive|visually impaired|\bAD\b|\bDVS\b|isolated score|music only/i;
    var LANG_WORD = { en: 'english', ja: 'japan', it: 'ital', fr: 'fren', de: 'german|deutsch', es: 'spanish|espa', pt: 'portug', ru: 'russian' };

    function isCommentary(label) { return SKIP_RE.test(String(label || '')); }

    // tracks: [{ lang, label }] in native order; wanted: ['en','eng'] or ['ja','jpn',...]
    function matches(track, wanted) {
        var tl = String(track.lang || '').toLowerCase(), lb = String(track.label || '').toLowerCase();
        if (wanted.indexOf(tl) >= 0 || wanted.indexOf(tl.substring(0, 2)) >= 0) return true;
        var w = LANG_WORD[String(wanted[0] || '').substring(0, 2)];
        return !!(w && new RegExp(w, 'i').test(lb));
    }
    function pick(tracks, wanted) {
        tracks = tracks || []; wanted = wanted || [];
        var first = -1;
        for (var i = 0; i < tracks.length; i++) {
            if (!matches(tracks[i], wanted)) continue;
            if (first < 0) first = i;
            if (!isCommentary(tracks[i].label)) return i;      // best: right language, not a commentary
        }
        return first;                                           // right language but only commentaries (or nothing): -1 keeps default
    }
    // After labels arrive later (server /tracks/ probe), should we move off `current`?
    // Returns the better index, or -1 to stay.
    function repick(tracks, wanted, current) {
        if (current < 0 || current >= (tracks || []).length) return -1;
        if (!isCommentary(tracks[current].label)) return -1;
        var better = pick(tracks, wanted);
        return (better >= 0 && better !== current && !isCommentary(tracks[better].label)) ? better : -1;
    }
    return { pick: pick, repick: repick, isCommentary: isCommentary };
}));
