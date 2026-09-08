import { test } from "node:test";
import assert from "node:assert/strict";
import { Pipeline } from "../web/src/player/pipeline.js";

function environment(t, managedOnly) {
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
      queueMicrotask(() => { source.readyState = "open"; source.dispatchEvent(new Event("sourceopen")); });
    },
    load() {},
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

test("missing streaming APIs fail clearly before fetching media", async t => {
  environment(t, true);
  Object.defineProperty(globalThis, "ManagedMediaSource", { configurable: true, value: undefined });
  const pipeline = new Pipeline({});
  await assert.rejects(pipeline.open("https://example.test/movie.mkv"), /does not support MediaSource or ManagedMediaSource/);
});
