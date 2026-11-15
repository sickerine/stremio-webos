// The attachment-free view (service/mkv-cut.js) has to stay a file a player can seek in:
// every stored position must still land on the element it names.
const assert = require('node:assert/strict');
const test = require('node:test');
const G = require('./mkv-gen.js');
const Cut = require('../service/mkv-cut.js');

const ID = G.ID;
const fixed = (id, value) => { const data = Buffer.alloc(4); data.writeUInt32BE(value); return G.el(id, data); };   // positions keep one width, so sizes do not move

// EBML, Segment(known size): SeekHead, Info, Tracks, [Attachments], Cluster x3, Cues, Tags
function file({ fontBytes = 1536 * 1024, withAttachments = true, cuesListed = true, checksums = false, tracksFirst = true } = {}) {
    const master = (id, kids) => G.master(id, checksums ? [G.el(ID.CRC32, Buffer.alloc(4, 0xc5))].concat(kids) : kids);
    const info = G.master(ID.INFO, [G.elU(ID.TIMESTAMPSCALE, 1000000)]);
    const tracks = G.master(ID.TRACKS, [G.master(ID.TRACKENTRY, [G.elU(ID.TRACKNUMBER, 1), G.elU(ID.TRACKTYPE, 1), G.elS(ID.CODECID, 'V_MPEG4/ISO/AVC')])]);
    const attachments = withAttachments ? G.master(ID.ATTACHMENTS, [G.master(ID.ATTACHEDFILE, [G.elS(ID.FILENAME, 'big.ttf'), G.elS(ID.FILEMIME, 'font/ttf'), G.el(ID.FILEDATA, Buffer.alloc(fontBytes, 7))])]) : Buffer.alloc(0);
    const clusters = [0, 1, 2].map(n => G.master(ID.CLUSTER, [G.elU(ID.TIMESTAMP, n * 1000), G.el(ID.SIMPLEBLOCK, Buffer.concat([G.vint(1), Buffer.from([0, 0, 0x80]), Buffer.alloc(5000, n + 1)]))]));
    const tags = G.master(ID.TAGS, [G.el(ID.VOID, Buffer.alloc(40))]);
    const layout = seekHead => {
        const at = {}; let pos = seekHead.length;
        at.info = pos; pos += info.length;
        if (tracksFirst) { at.tracks = pos; pos += tracks.length; }
        at.attachments = pos; pos += attachments.length;
        if (!tracksFirst) { at.tracks = pos; pos += tracks.length; }
        at.clusters = clusters.map(c => { const p = pos; pos += c.length; return p; }); at.cues = pos;
        return at;
    };
    const seekHeadFor = at => master(ID.SEEKHEAD, [[ID.INFO, at.info], [ID.TRACKS, at.tracks]].concat(withAttachments ? [[ID.ATTACHMENTS, at.attachments]] : [], cuesListed ? [[ID.CUES, at.cues]] : [])
        .map(([id, position]) => master(ID.SEEK, [G.el(ID.SEEKID, G.idBuf(id)), fixed(ID.SEEKPOSITION, position)])));
    const at = layout(seekHeadFor({ info: 0, tracks: 0, attachments: 0, cues: 0 }));
    const cues = master(ID.CUES, at.clusters.map((position, n) => master(ID.CUEPOINT, [G.elU(ID.CUETIME, n * 1000),
        master(ID.CUETRACKPOSITIONS, [G.elU(ID.CUETRACK, 1), fixed(ID.CUECLUSTERPOSITION, position)])])));
    const data = Buffer.concat([seekHeadFor(at), info].concat(tracksFirst ? [tracks, attachments] : [attachments, tracks], clusters, [cues, tags]));
    const ebml = G.master(ID.EBML, [G.elS(0x4282, 'matroska')]);
    return Buffer.concat([ebml, G.idBuf(ID.SEGMENT), G.vint(data.length, 8), data]);
}

// The view the tee serves: rewritten head, then everything after the cut with its Cues rewritten.
function view(bytes) {
    const plan = Cut.plan(bytes);
    const rest = Buffer.from(bytes.slice(plan.end));
    if (plan.cuesAt != null) assert.ok(Cut.cues(rest, plan, plan.cuesAt - plan.end), 'the Cues element is where the SeekHead says');
    return { plan, bytes: Buffer.concat([plan.head, rest]) };
}
function topLevel(bytes) {
    const segment = Cut.element(bytes, Cut.element(bytes, 0).end), found = [];
    for (let pos = segment.data; pos < bytes.length;) { const e = Cut.element(bytes, pos); found.push(e); pos = e.end; }
    return { segment, found };
}
const uint = (bytes, from, to) => { let v = 0; for (let i = from; i < to; i++) v = v * 256 + bytes[i]; return v; };
function inside(bytes, parent, id) {
    const out = [];
    for (let pos = parent.data; pos < parent.end;) { const e = Cut.element(bytes, pos); if (e.id === id) out.push(e); pos = e.end; }
    return out;
}

test('the view drops the Attachments element and every stored position still lands on its element', () => {
    const original = file(), { plan, bytes } = view(original);
    const before = topLevel(original), after = topLevel(bytes);
    const attachments = before.found.find(e => e.id === ID.ATTACHMENTS);
    assert.deepEqual([plan.start, plan.end], [attachments.start, attachments.end]);
    assert.equal(bytes.length, original.length - plan.cut);
    assert.equal(after.segment.size, bytes.length - after.segment.data, 'the Segment says how long it now is');
    assert.deepEqual(after.found.map(e => e.id), before.found.filter(e => e.id !== ID.ATTACHMENTS).map(e => e.id));

    const seekHead = after.found.find(e => e.id === ID.SEEKHEAD);
    const entries = inside(bytes, seekHead, ID.SEEK).map(seek => ({
        id: uint(bytes, inside(bytes, seek, ID.SEEKID)[0].data, inside(bytes, seek, ID.SEEKID)[0].end),
        position: uint(bytes, inside(bytes, seek, ID.SEEKPOSITION)[0].data, inside(bytes, seek, ID.SEEKPOSITION)[0].end) }));
    assert.deepEqual(entries.map(e => e.id), [ID.INFO, ID.TRACKS, ID.CUES], 'the entry for the missing element is gone');
    for (const entry of entries) assert.equal(Cut.element(bytes, after.segment.data + entry.position).id, entry.id);

    const cues = after.found.find(e => e.id === ID.CUES);
    const positions = inside(bytes, cues, ID.CUEPOINT).map(point => { const c = inside(bytes, inside(bytes, point, ID.CUETRACKPOSITIONS)[0], ID.CUECLUSTERPOSITION)[0]; return uint(bytes, c.data, c.end); });
    assert.equal(positions.length, 3);
    for (const position of positions) assert.equal(Cut.element(bytes, after.segment.data + position).id, ID.CLUSTER);
    assert.deepEqual(bytes.slice(plan.start, plan.start + 15000), original.slice(plan.end, plan.end + 15000), 'the picture data is untouched');
});

test('the plan waits for the Attachments header and leaves small or absent attachments alone', () => {
    const original = file(), attachments = topLevel(original).found.find(e => e.id === ID.ATTACHMENTS);
    assert.equal(Cut.plan(original.slice(0, attachments.start + 2)), undefined, 'header not in yet: ask again with more bytes');
    assert.ok(Cut.plan(original.slice(0, attachments.start + 16)), 'the header is enough; the fonts need not have arrived');
    assert.equal(Cut.plan(file({ withAttachments: false })), null);
    assert.equal(Cut.plan(file({ fontBytes: 200 * 1024 })), null, 'a small font set is not worth a second view');
    assert.equal(Cut.plan(Buffer.from('ftypisom-not-matroska-at-all')), null);
    assert.equal(Cut.plan(file({ cuesListed: false })), null, 'Cues that cannot be found would keep their old positions');
    assert.equal(Cut.plan(file({ tracksFirst: false })), null, 'the subtitle demuxer is handed the head before the cut: the Tracks must be in it');
});

test('no checksum is left over an element whose contents changed', () => {
    const { bytes } = view(file({ checksums: true })), { found } = topLevel(bytes);
    const checksums = parent => inside(bytes, parent, ID.CRC32).length;
    const seekHead = found.find(e => e.id === ID.SEEKHEAD), cues = found.find(e => e.id === ID.CUES);
    const points = inside(bytes, cues, ID.CUEPOINT);
    const rewritten = [seekHead, cues].concat(inside(bytes, seekHead, ID.SEEK), points, points.map(point => inside(bytes, point, ID.CUETRACKPOSITIONS)[0]));
    assert.equal(points.length, 3);
    assert.deepEqual(rewritten.map(checksums), rewritten.map(() => 0));
});
