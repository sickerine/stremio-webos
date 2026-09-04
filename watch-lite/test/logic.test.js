import { test } from "node:test";
import assert from "node:assert/strict";
import { planFromProbe, masterPlaylist } from "../src/media-manager.js";
import { estimateViewerPosition, synchronizationAction } from "../public/sync.js";

test("SubsPlease H.264/AAC/ASS release is copied, not transcoded, and picks the English sub", () => {
  const probe = { streams: [
    { index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" },
    { index: 1, codec_type: "audio", codec_name: "aac", tags: { language: "jpn" } },
    { index: 2, codec_type: "subtitle", codec_name: "ass", tags: { language: "eng" } },
  ] };
  const plan = planFromProbe(probe);
  assert.equal(plan.copyVideo, true);
  assert.equal(plan.copyAudio, true);
  assert.equal(plan.subtitleIndex, 2);
});

test("10-bit HEVC release transcodes video but still picks a subtitle track", () => {
  const probe = { streams: [
    { index: 0, codec_type: "video", codec_name: "hevc", pix_fmt: "yuv420p10le" },
    { index: 1, codec_type: "audio", codec_name: "flac" },
    { index: 2, codec_type: "subtitle", codec_name: "ass" },
  ] };
  const plan = planFromProbe(probe);
  assert.equal(plan.copyVideo, false);
  assert.equal(plan.copyAudio, false);
  assert.equal(plan.subtitleIndex, 2);
});

test("prefers an English sub over an earlier non-English one", () => {
  const probe = { streams: [
    { index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" },
    { index: 1, codec_type: "subtitle", codec_name: "subrip", tags: { language: "spa" } },
    { index: 2, codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng" } },
  ] };
  assert.equal(planFromProbe(probe).subtitleIndex, 2);
});

test("no subtitle track yields null index", () => {
  const probe = { streams: [
    { index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" },
    { index: 1, codec_type: "audio", codec_name: "aac" },
  ] };
  assert.equal(planFromProbe(probe).subtitleIndex, null);
});

test("buffering TV does not advance the estimated position (no pause storm feed)", () => {
  const base = { positionSeconds: 100, paused: false, playbackRate: 1, receivedAtMs: 0 };
  const playing = estimateViewerPosition({ ...base, buffering: false }, { offsetSeconds: 0 }, 5000);
  const buffering = estimateViewerPosition({ ...base, buffering: true }, { offsetSeconds: 0 }, 5000);
  assert.equal(playing, 105);      // 5s elapsed -> advanced
  assert.equal(buffering, 100);    // buffering -> frozen, not advanced
});

test("master playlist references the video variant and the subtitle group (ffmpeg omits the variant line)", () => {
  const withSubs = masterPlaylist({ withSubtitle: true });
  assert.match(withSubs, /#EXT-X-STREAM-INF:.*SUBTITLES="subs"/);
  assert.match(withSubs, /^stream_0\.m3u8$/m);
  assert.match(withSubs, /TYPE=SUBTITLES.*URI="stream_0_vtt\.m3u8"/);

  const noSubs = masterPlaylist({ withSubtitle: false });
  assert.match(noSubs, /^stream_0\.m3u8$/m);
  assert.doesNotMatch(noSubs, /SUBTITLES/);
});

test("sync policy: dead band, gentle rate nudge, hard seek", () => {
  assert.equal(synchronizationAction(100, 100.3).type, "none");
  assert.equal(synchronizationAction(100, 101).type, "rate");
  assert.equal(synchronizationAction(100, 105).type, "seek");
});
