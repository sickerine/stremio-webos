import { test } from "node:test";
import assert from "node:assert/strict";
import { Pipeline, selectAudioEncoder } from "../web/src/player/pipeline.js";

function environment(t, managedOnly, requiresPlay = false) {
  const saved = ["MediaSource", "ManagedMediaSource"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => { for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  let source;
  class Source extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() { super(); source = this; this.readyState = "closed"; }
    addSourceBuffer() { return {}; }
  }
  class ManagedSource extends Source {}
  Object.defineProperty(globalThis, "MediaSource", { configurable: true, value: managedOnly ? undefined : Source });
  Object.defineProperty(globalThis, "ManagedMediaSource", { configurable: true, value: ManagedSource });
  t.mock.method(URL, "createObjectURL", () => "blob:test");
  const video = {
    disableRemotePlayback: false,
    set src(value) {
      this.attached = value;
      if (managedOnly) assert.equal(this.disableRemotePlayback, true, "Safari must be configured before attaching the source");
      if (!requiresPlay) queueMicrotask(() => { source.readyState = "open"; source.dispatchEvent(new Event("sourceopen")); });
    },
    load() {},
    play() {
      this.playCalls = (this.playCalls || 0) + 1;
      if (requiresPlay) queueMicrotask(() => { source.readyState = "open"; source.dispatchEvent(new Event("sourceopen")); });
      return Promise.resolve();
    },
  };
  const pipeline = new Pipeline(video);
  pipeline.tracks = { video: { codec: "avc", codecString: "avc1.640028" }, audios: [], duration: 60 };
  pipeline._feed = async () => {};
  return { pipeline, video, Source, ManagedSource };
}

test("iPhone-style environment starts with ManagedMediaSource and disables remote playback", async t => {
  const { pipeline, video, ManagedSource } = environment(t, true);
  await pipeline.start(0);
  assert.ok(pipeline.mediaSource instanceof ManagedSource);
  assert.equal(video.disableRemotePlayback, true);
  assert.equal(video.attached, "blob:test");
  await pipeline._cancelRun();
});

test("the existing MediaSource path keeps remote playback unchanged", async t => {
  const { pipeline, video, Source, ManagedSource } = environment(t, false);
  await pipeline.start(0);
  assert.ok(pipeline.mediaSource instanceof Source);
  assert.ok(!(pipeline.mediaSource instanceof ManagedSource));
  assert.equal(video.disableRemotePlayback, false);
  await pipeline._cancelRun();
});

test("managed startup requests playback before waiting for sourceopen", { timeout: 500 }, async t => {
  const { pipeline, video } = environment(t, true, true);
  await pipeline.start(1200);
  assert.equal(video.playCalls, 1);
  assert.equal(pipeline.run.startAt, 1200);
  await pipeline._cancelRun();
});

test("a rejected startup offers a gesture retry instead of hanging invisibly", async t => {
  const { pipeline, video } = environment(t, true);
  const phases = [];
  pipeline.onStatus = status => phases.push(status.phase);
  video.play = () => Promise.reject(new DOMException("User gesture required", "NotAllowedError"));
  await pipeline.start(0);
  assert.equal(pipeline.needsPlaybackGesture, true);
  assert.ok(phases.includes("playback-blocked"));
  video.play = () => Promise.resolve();
  pipeline.requestPlayback();
  await Promise.resolve();
  assert.equal(pipeline.needsPlaybackGesture, false);
  await pipeline._cancelRun();
});

test("missing streaming APIs fail clearly before fetching media", async t => {
  environment(t, true);
  Object.defineProperty(globalThis, "ManagedMediaSource", { configurable: true, value: undefined });
  const pipeline = new Pipeline({});
  await assert.rejects(pipeline.open("https://example.test/movie.mkv"), /does not support MediaSource or ManagedMediaSource/);
});

test("Safari uses AAC when it can encode Opus but cannot play Opus in MP4", async () => {
  const calls = [];
  const encoder = await selectAudioEncoder({ isTypeSupported: mime => mime.includes("mp4a.40.2") }, "hev1.2.4.L150.90", async codec => { calls.push(codec); return true; });
  assert.deepEqual(encoder, { codec: "aac", codecString: "mp4a.40.2" });
  assert.deepEqual(calls, ["aac"]);
});

test("Opus remains preferred when both encoding and MP4 playback support it", async () => {
  assert.deepEqual(await selectAudioEncoder({ isTypeSupported: () => true }, "avc1.640028", async () => true), { codec: "opus", codecString: "opus" });
});

test("an audio encoder is unusable unless both playback and encoding are supported", async () => {
  assert.equal(await selectAudioEncoder({ isTypeSupported: () => true }, "avc1.640028", async () => false), null);
});
