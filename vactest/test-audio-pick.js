var assert = require('node:assert/strict');
var P = require('../service/overlay/audio-pick.js');
var EN = ['en', 'eng'], JA = ['ja', 'jpn', 'jp', 'jpz', 'jap'];
// The Incredible Hulk (NAHOM): native list = [AC-3 en "Commentary...", AAC en] (DTS ita dropped by LG)
var hulk = [{ lang: 'en', label: 'Commentary by Director Louis Leterrier/Actor Tim Roth' }, { lang: 'en', label: '' }];
assert.equal(P.pick(hulk, EN), 1, 'skips the commentary track');
// labels unknown at first (native labels empty) -> first English; once labels arrive, repick moves off the commentary
var blind = [{ lang: 'en', label: '' }, { lang: 'en', label: '' }];
assert.equal(P.pick(blind, EN), 0, 'without labels: first language match');
var labelled = [{ lang: 'en', label: 'Commentary by Director' }, { lang: 'en', label: '' }];
assert.equal(P.repick(labelled, EN, 0), 1, 'labels reveal a commentary: switch to the other English track');
assert.equal(P.repick(labelled, EN, 1), -1, 'already on the main track: stay');
assert.equal(P.repick([{ lang: 'en', label: 'Commentary' }], EN, 0), -1, 'commentary is the only English track: stay');
// only a commentary in the wanted language -> still that (better than a foreign track)
assert.equal(P.pick([{ lang: 'it', label: '' }, { lang: 'en', label: 'Director Commentary' }], EN), 1);
// anime: Japanese wanted; English dub first in Luna order
assert.equal(P.pick([{ lang: 'en', label: 'English' }, { lang: 'ja', label: '' }], JA), 1);
assert.equal(P.pick([{ lang: 'und', label: 'Japanese (Original)' }, { lang: 'und', label: 'English Dub' }], JA), 0, 'label word match when language codes are missing');
assert.equal(P.pick([{ lang: 'und', label: 'Japanese (Original)' }, { lang: 'und', label: 'English Dub' }], EN), 1);
// audio description is skipped like commentary
assert.equal(P.pick([{ lang: 'en', label: 'English - Audio Description' }, { lang: 'en', label: 'English 5.1' }], EN), 1);
assert.equal(P.pick([{ lang: 'eng', label: 'AD' }, { lang: 'eng', label: '' }], EN), 1);
// nothing in the wanted language -> -1 (keep the player default)
assert.equal(P.pick([{ lang: 'fr', label: '' }, { lang: 'de', label: '' }], EN), -1);
assert.equal(P.pick([], EN), -1);
// three-letter codes and case
assert.equal(P.pick([{ lang: 'ENG', label: 'Commentary' }, { lang: 'eng', label: 'Main' }], EN), 1);
assert.ok(P.isCommentary('Commentary by Director Louis Leterrier') && !P.isCommentary('English 7.1') && !P.isCommentary(''));
console.log('audio-pick: all checks passed');
