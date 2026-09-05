import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { BitmapDemux, buildMks, buildSup, vint } from "../web/src/subtitles/bitmap-demux.js";
const require = createRequire(import.meta.url);
const { EbmlStreamDecoder, EbmlTagId } = require("ebml-stream");

const tag = (id, data) => ({ id, data });
const master = (id, Children) => ({ id, Children });
const trackEntry = (n, codec, extra = []) => master(EbmlTagId.TrackEntry, [tag(EbmlTagId.TrackNumber, n), tag(EbmlTagId.TrackType, 0x11), tag(EbmlTagId.CodecID, codec), tag(EbmlTagId.CodecPrivate, Buffer.from("size: 720x480\npalette: 000000")), ...extra]);
const zlibEnc = master(EbmlTagId.ContentEncodings, [master(EbmlTagId.ContentEncoding, [master(EbmlTagId.ContentCompression, [tag(EbmlTagId.ContentCompAlgo, 0)])])]);

test("BitmapDemux lists bitmap tracks, times blocks by cluster + scale, inflates zlib blocks", async () => {
  const tracks = [], blocks = [];
  const d = new BitmapDemux({ onTracks: t => tracks.push(...t), onBlock: (t, b) => blocks.push([t.number, b]) });
  d.tap(tag(EbmlTagId.TimecodeScale, 1000000));
  d.tap(master(EbmlTagId.Tracks, [trackEntry(1, "V_MPEGH/ISO/HEVC"), trackEntry(3, "S_TEXT/ASS"), trackEntry(4, "S_VOBSUB", [zlibEnc, tag(EbmlTagId.Language, "dan")]), trackEntry(5, "S_HDMV/PGS")]));
  assert.deepEqual(tracks.map(t => [t.number, t.type, t.language, t.compression]), [[4, "vobsub", "dan", 0], [5, "pgs", undefined, null]]);
  d.tap(tag(EbmlTagId.Timecode, 60000));
  const spu = Buffer.from("hello-spu");
  d.tap({ id: EbmlTagId.SimpleBlock, track: 4, value: 250, lacing: 0, payload: deflateSync(spu) });
  d.tap(master(EbmlTagId.BlockGroup, [{ id: EbmlTagId.Block, track: 5, value: -10, lacing: 0, payload: Buffer.from([0x80, 0, 0]) }, tag(EbmlTagId.BlockDuration, 1500)]));
  d.tap({ id: EbmlTagId.SimpleBlock, track: 1, value: 0, lacing: 0, payload: Buffer.alloc(3) });     // video: ignored
  await new Promise(r => setTimeout(r, 20));
  blocks.sort((a, b) => a[0] - b[0]);
  assert.equal(blocks.length, 2);
  assert.deepEqual([blocks[0][0], blocks[0][1].time, Buffer.from(blocks[0][1].data).toString()], [4, 60250, "hello-spu"]);
  assert.deepEqual([blocks[1][0], blocks[1][1].time, blocks[1][1].duration], [5, 59990, 1500]);
});

test("buildSup wraps each PGS segment with a PG header carrying the block PTS", () => {
  const sup = buildSup([{ time: 2000, data: Uint8Array.of(0x16, 0, 1, 0xaa, 0x80, 0, 0) }]);
  assert.equal(sup.length, 10 + 4 + 10 + 3);
  assert.deepEqual([...sup.subarray(0, 6)], [0x50, 0x47, 0, 0x02, 0xbf, 0x20]);      // "PG", PTS 2000ms*90
  assert.deepEqual([...sup.subarray(10, 14)], [0x16, 0, 1, 0xaa]);
  assert.equal(sup[14 + 10], 0x80);                                                 // END segment follows its own header
});

test("buildMks is well-formed Matroska: one S_VOBSUB track and one block per cue", () => {
  assert.deepEqual([[...vint(0)], [...vint(126)], [...vint(127)], [...vint(70000)]], [[0x80], [0xfe], [0x40, 0x7f], [0x21, 0x11, 0x70]]);
  const track = { codecPrivate: new TextEncoder().encode("size: 720x480"), language: "eng" };
  const mks = buildMks(track, [{ time: 1000, duration: 2500, data: Uint8Array.of(1, 2, 3) }, { time: 90000, duration: 0, data: Uint8Array.of(9) }]);
  const seen = [];
  const dec = new EbmlStreamDecoder({ bufferTagIds: [EbmlTagId.Tracks, EbmlTagId.BlockGroup] });
  dec.on("data", t => seen.push(t));
  dec.write(Buffer.from(mks));
  const tracks = seen.find(t => t.id === EbmlTagId.Tracks);
  const entry = tracks.Children.find(t => t.id === EbmlTagId.TrackEntry);
  assert.equal(entry.Children.find(c => c.id === EbmlTagId.CodecID).data, "S_VOBSUB");
  assert.equal(Buffer.from(entry.Children.find(c => c.id === EbmlTagId.CodecPrivate).data).toString(), "size: 720x480");
  const clusters = seen.filter(t => t.id === EbmlTagId.Timecode).map(t => t.data);
  assert.deepEqual(clusters, [1000, 90000]);
  const groups = seen.filter(t => t.id === EbmlTagId.BlockGroup);
  const blk = groups[0].Children.find(c => c.id === EbmlTagId.Block);
  assert.deepEqual([blk.track, blk.value, [...blk.payload]], [1, 0, [1, 2, 3]]);
  assert.equal(groups[0].Children.find(c => c.id === EbmlTagId.BlockDuration).data, 2500);
  assert.equal(seen.find(t => t.id === EbmlTagId.DocType)?.data, "matroska");
});
