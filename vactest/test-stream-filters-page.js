// Runs the TV page's inline chip glue (service/index.html) with the shipped module,
// the way the TV loads it, and checks both chip modes end to end. Caught a real
// regression once: the anime helpers were dropped while wiring the module in.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../service/index.html'), 'utf8');
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(b => b.includes('var SF = window.StreamFilters'));
assert.ok(code, 'inline chip glue block found');
assert.ok(/<script src="\/stream-filters\.js"><\/script>/.test(html), 'module is loaded before the inline glue');

const window = { StreamFilters: require('../service/overlay/stream-filters.js'), addEventListener() {}, removeEventListener() {} };
const store = {}; const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
let location = { hash: '#/detail/movie/tt0800080/tt0800080' };
const fetch = () => Promise.resolve({ json: () => ({ ids: [] }) }); const setInterval = () => 0; const setTimeout = () => 0;
const document = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, body: {} };
const performance = { now: () => 0 }; const MutationObserver = function () { this.observe = () => {}; }; const requestAnimationFrame = () => 0;
eval(code);

const hulk = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus/hulk-movie.json'), 'utf8'));
const slime = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus/slime-s4e21.json'), 'utf8'));

// movie page: Supported by default, chip has the right options, partition is complete
assert.strictEqual(window.__streamKindFor(), 'supported');
assert.deepStrictEqual(window.__streamKindOptions('supported').map(o => o.label + (o.selected ? '*' : '')), ['All', 'Supported*', 'Unsupported']);
const sup = window.__applyStreamKind(hulk, 'supported').length, uns = window.__applyStreamKind(hulk, 'unsupported').length;
assert.strictEqual(sup + uns, hulk.length); assert.ok(uns >= 25, 'the DTS remuxes are hidden under Supported');
window.__setStreamKindFor('all'); assert.strictEqual(window.__streamKindFor(), 'all', 'choice remembered per title');

// anime page: All by default, anime options, seasonal/bd filters, own storage
location.hash = '#/detail/series/kitsu%3A49235/kitsu%3A49235%3A21';
assert.strictEqual(window.__streamKindFor(), 'all');
assert.deepStrictEqual(window.__streamKindOptions('all').map(o => o.label), ['All', 'Seasonal', 'BD']);
assert.ok(window.__applyStreamKind(slime, 'seasonal').length > 20, 'simulcast groups are seasonal');
assert.strictEqual(window.__applyStreamKind(slime, 'bd').length, 0, 'an airing episode has no BD yet');
assert.strictEqual(window.__applyStreamKind(slime, 'all').length, slime.length);
window.__setStreamKindFor('bd'); assert.strictEqual(window.__streamKindFor(), 'bd');
location.hash = '#/detail/movie/tt0800080/tt0800080'; assert.strictEqual(window.__streamKindFor(), 'all', 'anime and movie choices do not leak into each other');

// badges: one-word BDRemux earns the BD badge
assert.deepStrictEqual(window.__streamBadges({ name: '[TB+] Torrentio\n4k HDR', title: 'The.Incredible.Hulk.2008.4K.HDR.DV.2160p.BDRemux Ita Eng x265-NAHOM' }), ['4K', 'HDR', 'BD']);
console.log('page glue: all checks passed');
