// Pins the stream-list chip rules (service/overlay/stream-filters.js).
//   1. curated titles with hand-set expectations
//   2. a generated list: codec/source tokens x separators x casing x digit suffixes,
//      expectations derived from the TOKEN's known category, not from the regex
//   3. invariants over real torrentio lists saved in vactest/corpus/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('../service/overlay/stream-filters.js');

let checks = 0, failures = [];
function expect(title, field, want) {
    checks++;
    const got = field === 'bd' ? F.isBD(title) : field === 'seasonal' ? F.isSeasonal(title) : F.support(title);
    if (got !== want) failures.push(`${field.padEnd(8)} want ${String(want).padEnd(11)} got ${String(got).padEnd(11)} | ${title}`);
}

// ---------------------------------------------------------------- 1. curated
// [title, bd, seasonal, support]   support: supported | unsupported | unknown
const CURATED = [
    // --- anime: simulcast groups -> seasonal, not BD
    ['[SubsPlease] Tensei Shitara Slime Datta Ken S4 - 21 (1080p) [9057F2E5].mkv', false, true, 'unknown'],
    ['[Erai-raws] Tensei Shitara Slime Datta Ken 4th Season - 21 [1080p CR WEB-DL AVC AAC][MultiSub]', false, true, 'supported'],
    ['[ToonsHub] That Time I Got Reincarnated as a Slime S04E21 1080p BILI WEB-DL AAC2.0 H.265', false, true, 'supported'],
    ['[Judas] Sousou no Frieren - S01E01 [1080p][HEVC x265 10bit][Multi-Subs]', false, true, 'unknown'],
    ['[EMBER] Frieren Beyond Journey\'s End S01E01 [1080p] [HEVC WEBRip] (Sousou no Frieren)', false, true, 'unknown'],
    ['[ASW] Sousou no Frieren - 01 [1080p HEVC x265 10Bit][AAC]', false, true, 'supported'],
    ['[Ironclad] Yani Neko - S01E09 [WEB.1080p.AV1] | Chainsmoker Cat', false, true, 'unknown'],
    ['[Anime Time] One Piece - 1071 [1080p][HEVC 10bit x265][AAC][Multi Sub]', false, true, 'supported'],
    ['[Yameii] Frieren - S01E01 [English Dub] [CR WEB-DL 1080p] [ABCDEF12]', false, true, 'unknown'],
    ['Sousou no Frieren S01E01 1080p AMZN WEB-DL DDP2.0 H.264-VARYG', false, true, 'supported'],
    ['[Tsundere-Raws] Frieren - 01 VOSTFR [WEB 1080p x264 AAC]', false, true, 'supported'],
    ['[NC-Raws] Frieren - 01 [B-Global][WEB-DL][1080p][AVC AAC][ENG_TH_SRT]', false, true, 'supported'],
    ['Frieren.Beyond.Journeys.End.S01E01.1080p.HIDIVE.WEB-DL.AAC2.0.H.264-GROUP', false, true, 'supported'],
    ['Frieren S01E01 1080p NF WEB-DL DDP5.1 x264-Unknown', false, true, 'supported'],
    // --- anime: Blu-ray -> BD, never seasonal (even from a "seasonal" group)
    ['[Judas] Sousou no Frieren (Season 1) [BD 1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs]', true, false, 'unknown'],
    ['[EMBER] Frieren S01 [BDRip] [1080p HEVC 10 bits] (Batch)', true, false, 'unknown'],
    ['[Beatrice-Raws] Sousou no Frieren [BDRip 1920x1080 HEVC FLAC]', true, false, 'supported'],
    ['[Vodes] Frieren Beyond Journey\'s End (2023) [BD 1080p HEVC Dual-Audio]', true, false, 'unknown'],
    ['Sousou no Frieren S01 1080p BluRay x265 10bit Dual Audio FLAC 2.0-Kametsu', true, false, 'supported'],
    ['[Anime Time] One Piece (0001-1071+Movies+Specials) [BD+CR] [Dual Audio][1080p][HEVC 10bit x265][AAC]', true, false, 'supported'],
    ['[uba] That Time I Got Reincarnated as a Slime - S03 [BD Remux 1080p AVC FLAC]', true, false, 'supported'],
    ['[Reza] Slime S03 [BDRemux 1080p][FLAC Dual Audio]', true, false, 'supported'],
    ['Невероятный Халк / The Incredible Hulk (2008) UHD BDRemux 2160p', true, false, 'unknown'],
    ['Slime S01 BD1080p HEVC [JPBD] [Yousei-raws]', true, false, 'unknown'],
    ['Frieren 2023 1080p BDR AVC LPCM 2.0-Group', true, false, 'supported'],
    ['Frieren.2023.1080p.BRRip.x264.AAC-YTS', true, false, 'supported'],
    ['Frieren S01 [BDMV] [JP] [1080p]', true, false, 'unknown'],
    ['Frieren Blu-Ray 1080p x264 FLAC 2.0', true, false, 'supported'],
    ['[Yousei-raws] Frieren [USBD 1080p x265 FLAC]', true, false, 'supported'],
    // --- anime: neither (unknown group, no web tag) -> only under "All"
    ['[SomeRandomGroup] Frieren - 01 [1080p]', false, false, 'unknown'],
    ['Frieren 01 1080p x265', false, false, 'unknown'],
    // --- traps: words that look like tokens but are not
    ['Web of Lies S01E01 1080p BluRay x264-GROUP', true, false, 'unknown'],      // "Web" as a title word... but BD wins anyway
    ['Bandai.Namco.Documentary.1080p.HDTV.x264', false, false, 'unknown'],       // "Bd" inside a word
    ['Crazy.Rich.Asians.2018.1080p.HDTV.x264', false, false, 'unknown'],          // "Cr" inside a word
    ['Bluey.S01.1080p.DSNP.WEB-DL.DDP5.1.H.264', false, true, 'supported'],       // "Blu" is not Blu-ray
    // --- movies/series: DTS / TrueHD only -> unsupported
    ['The Incredible Hulk 2008 UHD BluRay 2160p DTS-X 7 1 DV HEVC HYBRID REMUX-FraMeSToR', true, false, 'unsupported'],
    ['The.Incredible.Hulk.2008.2160p.BluRay.REMUX.HEVC.DTS-X.7.1-FGT', true, false, 'unsupported'],
    ['The.Incredible.Hulk.2008.2160p.UHD.BluRay.x265.10bit.HDR.DTS-X.7.1-IAMABLE', true, false, 'unsupported'],
    ['The Incredible Hulk 2008 UHD BluRay 2160p DV HEVC DTS-HDMA DTS-X 7.1 x265-E', true, false, 'unsupported'],
    ['Iron.Man.2008.US.2160p.UHD.BluRay.X265.10bit.HDR.TrueHD.7.1.Atmos-TERMiNAL', true, false, 'unsupported'],
    ['Movie.2008.2160p.BluRay.REMUX.HEVC.TrueHD.7.1-FGT', true, false, 'unsupported'],
    ['Movie.2010.1080p.BluRay.x264.DTS-HD.MA.5.1-GROUP', true, false, 'unsupported'],
    ['Movie.2010.1080p.BluRay.x264.DTS5.1-GROUP', true, false, 'unsupported'],
    ['Movie 2010 1080p BluRay x264 DTS:X 7.1', true, false, 'unsupported'],
    ['Movie 2010 1080p BluRay x264 DTSX', true, false, 'unsupported'],
    ['Movie.2010.1080p.BluRay.DTS-ES.6.1.x264', true, false, 'unsupported'],
    ['Movie.2010.1080p.BluRay.TrueHD7.1.x264', true, false, 'unsupported'],
    ['Movie.2010.1080p.BluRay.True-HD.5.1.x264', true, false, 'unsupported'],
    ['Lincredibile Hulk (2008) UHDRip 2160p HEVC HDR ITA DTS ENG DTS-X 7.1 PirateMKV.mkv', false, false, 'unsupported'],
    ['Movie.2020.2160p.UHD.BluRay.REMUX.HEVC.Atmos-GROUP', true, false, 'unsupported'],     // Atmos on a remux = TrueHD
    // --- movies/series: a decodable track present -> supported (even next to DTS)
    ['The Incredible Hulk.2008.2160p.DV.HDR10 .WEB-DL.Atmos.DDP5.1.x265.BluBit', false, true, 'supported'],
    ['The.Incredible.Hulk.2008.2160p.UHD.BluRay.x265.10bit.HDR.DDP5.1-RARBG', true, false, 'supported'],
    ['The Incredible Hulk (2008) (2160p BluRay x265 HEVC 10bit HDR AAC 7.1 Tigole) [QxR]', true, false, 'supported'],
    ['Hulk.2.Pack.BDRips.2160p.UHD.HDR.Eng.DTS-HD.MA.DD5.1.gerald99', true, false, 'supported'],
    ['The.Incredible.Hulk.2008.2160p.UHD.HDR.BluRay.(x265 10bit DD5.1).[WMAN-LorD]', true, false, 'supported'],
    ['Hulk 2160p DV ITA DTS 5.1 ITA ENG AC3 5.1 SUB ITA ENG', false, false, 'supported'],
    ['Movie 2160p Bluray x265 DDP DTS-KiNGDOM', true, false, 'supported'],
    ['Movie.2020.2160p.WEB-DL.Atmos.x265-GROUP', false, true, 'supported'],       // Atmos on web = DD+
    ['Movie.2020.2160p.DSNP.WEB-DL.DDPA5.1.H.265', false, true, 'supported'],
    ['Movie.2020.1080p.WEB-DL.DD+5.1.H.264', false, true, 'supported'],
    ['Movie.2020.1080p.WEB-DL.E-AC-3.5.1.H.264', false, true, 'supported'],
    ['Movie.2020.1080p.WEB-DL.EAC3.5.1.H.264', false, true, 'supported'],
    ['Movie.2020.1080p.BluRay.AC3.5.1.x264', true, false, 'supported'],
    ['Movie.2020.1080p.BluRay.AC-3.5.1.x264', true, false, 'supported'],
    ['Movie 2020 1080p BluRay x264 Dolby Digital 5.1', true, false, 'supported'],
    ['Movie 2020 1080p WEB Dolby Digital Plus 5.1', false, true, 'supported'],
    ['Movie.2020.1080p.WEBRip.x264.AAC5.1-YTS', false, true, 'supported'],
    ['Movie.2020.1080p.BluRay.x264.HE-AAC.2.0', true, false, 'supported'],
    ['Movie.2020.1080p.BluRay.FLAC.2.0.x264', true, false, 'supported'],
    ['Movie.2020.1080p.WEB.Opus.2.0.VP9', false, true, 'supported'],
    ['Movie.2020.1080p.BluRay.LPCM.2.0.x264', true, false, 'supported'],
    ['Movie.2020.1080p.BluRay.PCM.2.0.x264', true, false, 'supported'],
    ['Movie.2020.1080p.WEBRip.MP3.2.0', false, true, 'supported'],
    ['El increible Hulk [FullBluRay 1080p][Castellano AC3 5.1-TrueHD 5.1-Ingles TrueHD 5.1+Subs]', true, false, 'supported'],
    // --- movies/series: no codec named -> unknown (stays visible)
    ['The Incredible Hulk 2008 2160p BluRay', true, false, 'unknown'],
    ['The Incredible Hulk 2008 x264 2160p', false, false, 'unknown'],
    ['Some.Show.S01E01.1080p.WEB.H264-GROUP', false, true, 'unknown'],
    ['Movie 2020 1080p Dual Audio [Hindi English] ESub', false, false, 'unknown'],
    ['Movie.2020.2160p.DV.HDR10.x265-GROUP', false, false, 'unknown'],           // "DV" is Dolby Vision, not Dolby Digital
    ['Movie.2020.2160p.DoVi.HDR.HEVC-GROUP', false, false, 'unknown'],
    ['Movie 2020 1080p 5.1 x264', false, false, 'unknown'],
    // --- video: 10-bit H.264 has no TV decoder
    ['[Group] Frieren - 01 [1080p Hi10P AAC]', false, false, 'unsupported'],
    ['[Group] Frieren - 01 [1080p x264 10bit FLAC]', false, false, 'unsupported'],
    ['[Group] Frieren - 01 [1080p 10-bit H.264 AAC]', false, false, 'unsupported'],
    ['[Group] Frieren - 01 [1080p Hi444PP]', false, false, 'unsupported'],
    ['Movie.2020.2160p.x265.10bit.HDR.DDP5.1', false, false, 'supported'],          // x265 10-bit is fine
    ['Movie.2020.2160p.HEVC.10-bit.AAC', false, false, 'supported'],
    // --- traps for the audio rules
    ['My.Little.Pony.S01E01.1080p.WEB-DL.AAC2.0.H.264', false, true, 'supported'],  // "MLP" is not Meridian Lossless here
    ['Movie.2020.1080p.BluRay.x264-DTS', true, false, 'unsupported'],               // group literally named DTS: still flags (acceptable)
    ['Dolby.Vision.Demo.2160p.x265-GROUP', false, false, 'unknown'],
    ['Movie 2020 1080p WEB-DL H264 AAC 2.0 [HDTV]', false, true, 'supported'],
    ['Movie.2020.1080p.HDTV.x264-GROUP', false, false, 'unknown'],
];
for (const [t, bd, seasonal, support] of CURATED) { expect(t, 'bd', bd); expect(t, 'seasonal', seasonal); expect(t, 'support', support); }

// ---------------------------------------------------------------- 2. generated
// Tokens with their KNOWN category; the expectation is built from the category,
// so this exercises boundaries/separators/casing/digits rather than the regex.
const OK_TOKENS   = ['DDP5.1', 'DDP', 'DD5.1', 'DD+5.1', 'DD+7.1', 'DDPA5.1', 'AC3', 'AC-3', 'EAC3', 'E-AC-3', 'AAC', 'AAC2.0', 'HE-AAC', 'FLAC', 'Opus', 'MP3', 'PCM', 'LPCM', 'Dolby Digital', 'Dolby.Digital.Plus'];
const NO_TOKENS   = ['DTS', 'DTS5.1', 'DTS-HD', 'DTS-HD.MA', 'DTS-HD MA 7.1', 'DTS-HDMA', 'DTS:X', 'DTS-X', 'DTSX', 'DTS-ES', 'TrueHD', 'TrueHD7.1', 'True-HD', 'TrueHD.Atmos', 'TrueHD 7.1 Atmos'];
const NONE_TOKENS = ['5.1', '7.1', 'Dual Audio', 'MULTi', 'DV', 'HDR10', 'HDR', 'DoVi'];
const BD_SRC   = ['BluRay', 'Blu-ray', 'Bluray', 'BDRip', 'BDRemux', 'BD Remux', 'BD-Remux', 'REMUX', 'BDMV', 'BRRip', 'BD1080p', 'UHD.BluRay', 'JPBD'];
const WEB_SRC  = ['WEB-DL', 'WEBDL', 'WEBRip', 'WEB', 'AMZN.WEB-DL', 'NF.WEB-DL', 'DSNP.WEB-DL', 'HIDIVE', 'CR', 'B-Global', 'BILI'];
const NEUTRAL_SRC = ['HDTV', 'UHDRip', '2160p', '1080p'];
const SEPS = ['.', ' ', '_', '-'];
const CASES = [s => s, s => s.toLowerCase(), s => s.toUpperCase()];
let generated = 0;
function gen(src, srcKind, tok, tokKind) {
    for (const sep of SEPS) for (const cs of CASES) {
        const title = cs(['Movie', '2020', '2160p', src, tok, 'x265', 'GROUP'].join(sep).replace(/ /g, sep === ' ' ? ' ' : sep));
        generated++;
        expect(title, 'bd', srcKind === 'bd');
        expect(title, 'seasonal', srcKind === 'web');
        const want = tokKind === 'ok' ? 'supported' : tokKind === 'no' ? 'unsupported' : 'unknown';
        expect(title, 'support', want);
    }
}
for (const src of BD_SRC)      { for (const t of OK_TOKENS) gen(src, 'bd', t, 'ok'); for (const t of NO_TOKENS) gen(src, 'bd', t, 'no'); for (const t of NONE_TOKENS) gen(src, 'bd', t, 'none'); }
for (const src of WEB_SRC)     { for (const t of OK_TOKENS) gen(src, 'web', t, 'ok'); for (const t of NO_TOKENS) gen(src, 'web', t, 'no'); for (const t of NONE_TOKENS) gen(src, 'web', t, 'none'); }
for (const src of NEUTRAL_SRC) { for (const t of OK_TOKENS) gen(src, 'none', t, 'ok'); for (const t of NO_TOKENS) gen(src, 'none', t, 'no'); for (const t of NONE_TOKENS) gen(src, 'none', t, 'none'); }
// mixed: a decodable track next to an undecodable one is playable
for (const no of NO_TOKENS) for (const ok of OK_TOKENS) { generated++; expect(`Movie.2020.2160p.BluRay.${no}.${ok}.x265-GROUP`, 'support', 'supported'); }

// ---------------------------------------------------------------- 3. real corpus
const corpusDir = path.join(__dirname, 'corpus');
const corpus = {};
for (const f of fs.readdirSync(corpusDir).filter(f => f.endsWith('.json'))) corpus[f.replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(corpusDir, f), 'utf8'));
const VALID = new Set(['supported', 'unsupported', 'unknown']);
const summary = [];
for (const [name, streams] of Object.entries(corpus)) {
    const counts = { bd: 0, seasonal: 0, supported: 0, unsupported: 0, unknown: 0, both: 0 };
    for (const s of streams) {
        const t = F.text(s), sup = F.support(t);
        checks++; if (!VALID.has(sup)) failures.push(`corpus ${name}: invalid support label ${sup} | ${t.slice(0, 80)}`);
        const bd = F.isBD(t), se = F.isSeasonal(t);
        checks++; if (bd && se) { counts.both++; failures.push(`corpus ${name}: BD and Seasonal both true | ${t.slice(0, 80)}`); }
        counts[sup]++; if (bd) counts.bd++; if (se) counts.seasonal++;
        // every DTS/TrueHD-only remux in the wild must be flagged
        if (/remux/i.test(t) && /dts|truehd/i.test(t) && !/ddp?[ .]?\d|ac-?3|eac3|aac|flac|opus|pcm/i.test(t)) { checks++; if (sup !== 'unsupported') failures.push(`corpus ${name}: DTS/TrueHD remux not flagged | ${t.slice(0, 90)}`); }
    }
    summary.push(`${name.padEnd(18)} n=${String(streams.length).padStart(3)}  bd=${counts.bd} seasonal=${counts.seasonal}  supported=${counts.supported} unknown=${counts.unknown} unsupported=${counts.unsupported}`);
}
// anchors in the real lists
const find = (name, needle) => corpus[name].find(s => F.text(s).includes(needle));
const anchors = [
    ['hulk-movie', 'FraMeSToR', 'support', 'unsupported'], ['hulk-movie', 'BluBit', 'support', 'supported'], ['hulk-movie', 'Tigole', 'support', 'supported'],
    ['hulk-movie', 'gerald99', 'support', 'supported'], ['hulk-movie', 'BDRemux Ita Eng x265-NAHOM', 'bd', true],
    ['slime-s4e21', '[SubsPlease]', 'seasonal', true], ['slime-s4e21', '[SubsPlease]', 'bd', false], ['slime-s4e21', '[Erai-raws]', 'seasonal', true],
    ['ironman-movie', 'TrueHD.7.1.Atmos-TERMiNAL', 'support', 'unsupported'],
];
for (const [name, needle, field, want] of anchors) { const s = find(name, needle); checks++; if (!s) { failures.push(`corpus ${name}: anchor not found: ${needle}`); continue; } expect(F.text(s), field, want); }

// ---------------------------------------------------------------- chip plumbing
{
    const anime = F.kindOptions(true, 'bd'), other = F.kindOptions(false, 'supported');
    assert.deepStrictEqual(anime.map(o => o.label), ['All', 'Seasonal', 'BD']); assert.strictEqual(anime[2].selected, true);
    assert.deepStrictEqual(other.map(o => o.label), ['All', 'Supported', 'Unsupported']); assert.strictEqual(other[1].selected, true);
    assert.strictEqual(F.defaultKind(true), 'all'); assert.strictEqual(F.defaultKind(false), 'supported');
    const list = corpus['hulk-movie'];
    const sup = F.filterByKind(list, 'supported', false), uns = F.filterByKind(list, 'unsupported', false);
    assert.strictEqual(sup.length + uns.length, list.length, 'supported + unsupported partition the list');
    assert.strictEqual(F.filterByKind(list, 'all', false).length, list.length);
    assert.ok(F.filterByKind(corpus['slime-s4e21'], 'seasonal', true).length > 0);
    checks += 6;
}

console.log(summary.join('\n'));
console.log(`\n${checks} checks (${CURATED.length} curated titles, ${generated} generated titles, ${Object.values(corpus).reduce((a, b) => a + b.length, 0)} real streams)`);
if (failures.length) { console.log(`\n${failures.length} FAILURES:`); for (const f of failures.slice(0, 60)) console.log('  ' + f); if (failures.length > 60) console.log(`  ... ${failures.length - 60} more`); process.exit(1); }
console.log('all passed');
