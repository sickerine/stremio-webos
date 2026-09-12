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


test("stop supersedes a pending seek without reviving a closed pipeline", async t => {
  const { pipeline } = environment(t, true);
  await pipeline.start(0);
  let release;
  pipeline._whenIdle = () => new Promise(resolve => { release = resolve; });
  const seek = pipeline.start(20);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await pipeline.close();
  release();
  await seek;
  assert.equal(pipeline.mediaSource, null);
  assert.equal(pipeline.run, null);
  assert.equal(pipeline.tracks, null);
});

function bufferEnvironment(t, { quota = 1, canEvict = true, appendError = false } = {}) {
  const { pipeline, video } = environment(t, false);
  video.currentTime = 60;
  const accepted = [], calls = [];
  let start = 0, attempts = 0;
  const sb = new EventTarget();
  Object.assign(sb, {
    updating: false,
    buffered: { length: 1, start: () => canEvict ? start : 60, end: () => 150 },
    appendBuffer(chunk) {
      assert.equal(this.updating, false);
      calls.push("append"); attempts++;
      if (attempts <= quota) throw new DOMException("Buffer full", "QuotaExceededError");
      this.updating = true;
      setImmediate(() => {
        if (appendError) this.dispatchEvent(new Event("error"));
        else accepted.push([...chunk]);
        this.updating = false; this.dispatchEvent(new Event("updateend"));
      });
    },
    remove(a, b) {
      assert.equal(this.updating, false);
      calls.push("remove"); this.updating = true;
      setImmediate(() => { start = b; this.updating = false; this.dispatchEvent(new Event("updateend")); });
    },
  });
  pipeline.sourceBuffer = sb;
  pipeline.mediaSource = { readyState: "open" };
  return { pipeline, accepted, calls };
}

test("a full media buffer retries the same bytes after eviction before accepting the next chunk", async t => {
  const { pipeline, accepted, calls } = bufferEnvironment(t);
  await Promise.all([pipeline._append(Uint8Array.of(1, 2)), pipeline._append(Uint8Array.of(3, 4))]);
  assert.deepEqual(accepted, [[1, 2], [3, 4]]);
  assert.deepEqual(calls, ["append", "remove", "append", "append"]);
});

test("buffer pressure without removable history waits and can be cancelled without dropping into a later chunk", { timeout: 1500 }, async t => {
  const { pipeline, accepted } = bufferEnvironment(t, { quota: Infinity, canEvict: false });
  let completed = false;
  const writing = pipeline._append(Uint8Array.of(1)).then(() => { completed = true; });
  await new Promise(r => setTimeout(r, 25));
  assert.equal(completed, false);
  await pipeline.close();
  await writing;
  assert.deepEqual(accepted, []);
});

test("asynchronous SourceBuffer errors reject the write instead of reporting successful append", async t => {
  const { pipeline, accepted } = bufferEnvironment(t, { quota: 0, appendError: true });
  await assert.rejects(pipeline._append(Uint8Array.of(1)), /SourceBuffer/);
  assert.deepEqual(accepted, []);
});

test("cancelling a feed releases an append waiting for buffer space", { timeout: 1500 }, async t => {
  const { pipeline, accepted } = bufferEnvironment(t, { quota: Infinity, canEvict: false });
  pipeline.run = { cancelled: false, output: { cancel: () => pipeline.appendQueue } };
  const writing = pipeline._append(Uint8Array.of(1));
  await new Promise(r => setTimeout(r, 25));
  await pipeline._cancelRun();
  await writing;
  assert.deepEqual(accepted, []);
  assert.equal(pipeline.run, null);
});
