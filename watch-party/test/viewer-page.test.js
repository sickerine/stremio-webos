import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrowserDeviceId, createPassiveViewer } from "../public/viewer.js";

class FakeElement {
  constructor() {
    this.hidden = false;
    this.children = [];
    this.style = {};
    this.listeners = new Map();
    this.dataset = {};
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name),
      contains: name => this.classes.has(name),
      remove: name => this.classes.delete(name),
      toggle: (name, force) => force ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
}

class FakeFrameDocument {
  constructor() {
    this.head = new FakeElement();
    this.documentElement = new FakeElement();
    this.listeners = new Map();
    this.video = null;
  }
  getElementById(id) { return this.head.children.find(child => child.id === id) || null; }
  createElement() { return new FakeElement(); }
  querySelector(selector) { return selector === "video" ? this.video : null; }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  dispatch(name, event) {
    for (const listener of this.listeners.get(name) || []) {
      listener(event);
      if (event.immediatePropagationStopped) break;
    }
  }
}

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  emit(name, data = {}) { this.listeners.get(name)?.(data); }
  message(payload) { this.emit("message", { data: JSON.stringify(payload) }); }
  close() { this.emit("close"); }
}

function setup({ bootstrapPromise } = {}) {
  FakeSocket.instances = [];
  const elements = {
    waiting: new FakeElement(),
    player: new FakeElement(),
    "status-title": new FakeElement(),
    "status-body": new FakeElement(),
    "sound-prompt": new FakeElement(),
    "cold-paused-hover-catcher": new FakeElement(),
  };
  const frames = [];
  const document = {
    getElementById: id => elements[id],
    createElement: tag => {
      assert.equal(tag, "iframe");
      const frame = new FakeElement();
      frame.contentWindow = {
        location: { hash: "#/home" },
        document: new FakeFrameDocument(),
      };
      frames.push(frame);
      return frame;
    },
  };
  const values = new Map();
  const storage = { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key) };
  const intervals = [];
  const timeouts = [];
  const bootstrap = {
    serverId: "server-id", userId: "user-id", accessToken: "token",
    user: { Id: "user-id", Name: "watchparty" },
  };
  const controller = createPassiveViewer({
    document,
    location: { origin: "http://watch.test", protocol: "http:", host: "watch.test" },
    storage,
    WebSocketImplementation: FakeSocket,
    fetchImplementation: async () => ({ ok: true, json: async () => bootstrapPromise ? bootstrapPromise : bootstrap }),
    setIntervalImplementation: callback => { intervals.push(callback); return intervals.length; },
    clearIntervalImplementation: () => {},
    setTimeoutImplementation: callback => { timeouts.push(callback); return timeouts.length; },
    clearTimeoutImplementation: () => {},
    createDeviceId: () => "viewer-device-123",
  });
  return { controller, elements, frames, values, intervals, timeouts, bootstrap };
}

test("device IDs work on LAN HTTP origins without crypto.randomUUID", () => {
  const values = Array.from({ length: 16 }, (_, index) => index);
  const cryptoImplementation = {
    getRandomValues(buffer) {
      buffer.set(values);
      return buffer;
    },
  };

  assert.equal(
    createBrowserDeviceId(cryptoImplementation),
    "stremio-watch-00010203-0405-4607-8809-0a0b0c0d0e0f",
  );
});

test("a fresh viewer needs no login and reveals only active TV video", async () => {
  const { elements, frames, values, intervals } = setup();
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, "ws://watch.test/ws?role=viewer");
  assert.equal(elements.waiting.hidden, false);
  assert.equal(elements.player.hidden, true);

  socket.message({ type: "viewer-state", mode: "playing", sessionId: "episode-1", title: "Episode 1" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].src, "/web/#/video");
  assert.match(values.get("jellyfin_credentials"), /"AccessToken":"token"/);
  assert.equal(values.get("_deviceId2"), "viewer-device-123");
  assert.equal(values.get("stremio-watch-device-id"), "viewer-device-123");
  assert.equal(elements.waiting.hidden, false);
  assert.equal(elements.player.hidden, false, "the covered iframe stays active for Jellyfin remote control");

  frames[0].contentWindow.document.querySelector = selector => selector === "video" ? { readyState: 4 } : null;
  intervals[0]();
  assert.equal(elements.waiting.hidden, true);
  assert.equal(elements.player.hidden, false);
  assert.equal(frames[0].contentWindow.location.hash, "#/video");
  socket.message({ type: "viewer-state", mode: "waiting" });
  assert.equal(elements.waiting.hidden, false);
  assert.equal(elements.player.hidden, true);
  assert.equal(elements.player.children.length, 1, "the ready Jellyfin frame stays warm while hidden");
});

test("Jellyfin warms up before the TV starts playing", async () => {
  const { elements, frames, values, intervals } = setup();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(frames.length, 1);
  assert.equal(frames[0].src, "/web/#/video");
  assert.match(values.get("jellyfin_credentials"), /"AccessToken":"token"/);
  assert.equal(elements.waiting.hidden, false);
  assert.equal(elements.player.hidden, true);

  intervals[0]();
  assert.equal(elements.waiting.hidden, false, "a ready background frame does not leave waiting mode");
});

test("duplicate TV heartbeats do not recreate the player", async () => {
  const { frames } = setup();
  const socket = FakeSocket.instances[0];
  const playing = { type: "viewer-state", mode: "playing", sessionId: "episode-1", title: "Episode 1" };
  socket.message(playing);
  await Promise.resolve();
  await Promise.resolve();
  socket.message(playing);
  await Promise.resolve();
  assert.equal(frames.length, 1);
  socket.message({ ...playing, sessionId: "episode-2", title: "Episode 2" });
  await Promise.resolve();
  assert.equal(frames.length, 1, "episode changes reuse the ready Jellyfin player");
});

test("TV idle lets an unfinished player bootstrap complete in the background", async () => {
  let finishBootstrap;
  const bootstrapPromise = new Promise(resolve => { finishBootstrap = resolve; });
  const { elements, frames, bootstrap } = setup({ bootstrapPromise });
  const socket = FakeSocket.instances[0];
  socket.message({ type: "viewer-state", mode: "playing", sessionId: "episode-1", title: "Episode 1" });
  socket.message({ type: "viewer-state", mode: "waiting" });
  finishBootstrap(bootstrap);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.length, 1);
  assert.equal(elements.waiting.hidden, false);
  assert.equal(elements.player.hidden, true);
});

test("blocked audible autoplay falls back to video with a one-action sound prompt", async () => {
  const { elements, frames, intervals } = setup();
  const socket = FakeSocket.instances[0];
  socket.message({ type: "viewer-state", mode: "playing", sessionId: "episode-1", paused: false });
  await Promise.resolve();
  await Promise.resolve();

  let playCalls = 0;
  const video = {
    readyState: 4,
    paused: true,
    muted: false,
    play() {
      playCalls += 1;
      if (playCalls === 1) return Promise.reject(new Error("NotAllowedError"));
      this.paused = false;
      return Promise.resolve();
    },
  };
  frames[0].contentWindow.document.querySelector = selector => selector === "video" ? video : null;
  intervals[0]();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(playCalls, 2);
  assert.equal(video.muted, true);
  assert.equal(elements["sound-prompt"].hidden, false);
  assert.equal(elements.waiting.hidden, true);

  elements["sound-prompt"].listeners.get("click")();
  await Promise.resolve();
  assert.equal(video.muted, false);
  assert.equal(elements["sound-prompt"].hidden, true);
});

test("a viewer joining while the TV is paused does not start playback", async () => {
  const { frames, intervals } = setup();
  const socket = FakeSocket.instances[0];
  socket.message({ type: "viewer-state", mode: "playing", sessionId: "episode-1", paused: true });
  await Promise.resolve();
  await Promise.resolve();
  let playCalls = 0;
  frames[0].contentWindow.document.querySelector = selector => selector === "video"
    ? { readyState: 4, paused: true, muted: false, play: () => { playCalls += 1; } }
    : null;
  intervals[0]();
  assert.equal(playCalls, 0);
});

test("a paused or buffering video reveals Jellyfin controls immediately", async () => {
  const { elements, frames, intervals } = setup();
  const socket = FakeSocket.instances[0];
  socket.message({ type: "viewer-state", mode: "playing", sessionId: "episode-1", paused: true });
  await Promise.resolve();
  await Promise.resolve();

  frames[0].contentWindow.document.video = {
    readyState: 1,
    paused: true,
    muted: false,
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
  intervals[0]();

  assert.equal(elements.waiting.hidden, true);
  assert.equal(elements.player.hidden, false);
});

test("TV heartbeats correct browser drift and apply pause locally", async () => {
  const { frames, intervals } = setup();
  const socket = FakeSocket.instances[0];
  socket.message({
    type: "viewer-state", mode: "playing", sessionId: "episode-1",
    paused: false, positionSeconds: 30,
  });
  await Promise.resolve();
  await Promise.resolve();

  let pauseCalls = 0;
  let playCalls = 0;
  const video = {
    readyState: 4, duration: 1_400, currentTime: 20, paused: false, muted: false,
    pause() { pauseCalls += 1; this.paused = true; },
    play() { playCalls += 1; this.paused = false; return Promise.resolve(); },
  };
  frames[0].contentWindow.document.querySelector = selector => selector === "video" ? video : null;
  intervals[0]();
  assert.ok(video.currentTime >= 30 && video.currentTime < 30.1);

  video.currentTime = 700;
  video.pause();
  assert.ok(video.currentTime >= 30 && video.currentTime < 30.1, "a viewer cannot seek");
  assert.equal(video.paused, false, "a viewer cannot pause");
  assert.equal(pauseCalls, 0);

  socket.message({
    type: "viewer-state", mode: "playing", sessionId: "episode-1",
    paused: true, positionSeconds: 45,
  });
  intervals[0]();
  assert.equal(video.currentTime, 45);
  assert.equal(video.paused, true);
  assert.equal(pauseCalls, 1);

  video.currentTime = 900;
  await video.play();
  assert.equal(video.currentTime, 45, "a viewer still cannot seek while paused");
  assert.equal(video.paused, true, "a viewer cannot resume playback");
  assert.equal(playCalls, 0);

  socket.message({
    type: "viewer-state", mode: "playing", sessionId: "episode-1",
    paused: false, positionSeconds: 50,
  });
  intervals[0]();
  await Promise.resolve();
  assert.equal(video.paused, false, "the TV can resume playback");
  assert.equal(playCalls, 1);
});

test("the passive controller leaves subtitle and audio selection to Jellyfin", async () => {
  const { frames, intervals } = setup();
  const socket = FakeSocket.instances[0];
  socket.message({ type: "viewer-state", mode: "playing", sessionId: "episode-1", paused: true });
  await Promise.resolve();
  await Promise.resolve();

  const tracks = [];
  const frameDocument = frames[0].contentWindow.document;
  frameDocument.createElement = tag => {
    const element = new FakeElement();
    element.tagName = tag.toUpperCase();
    if (tag === "track") element.track = { mode: "disabled" };
    tracks.push(element);
    return element;
  };
  frameDocument.querySelector = selector => selector === "video" ? video : null;
  const video = new FakeElement();
  video.ownerDocument = frameDocument;
  video.readyState = 4;
  video.duration = 1_400;
  video.currentTime = 20;
  video.paused = true;

  socket.message({
    type: "viewer-state", mode: "playing", sessionId: "episode-1", paused: true,
    itemId: "item-id", mediaSourceId: "source-id", subtitleIndex: 4,
  });
  intervals[0]();
  assert.equal(tracks.some(element => element.tagName === "TRACK"), false);
});

test("the passive player limits forced visibility to cold-paused hover", async () => {
  const { frames, intervals } = setup();
  const socket = FakeSocket.instances[0];
  socket.message({ type: "viewer-state", mode: "playing", sessionId: "episode-1", paused: true });
  await Promise.resolve();
  await Promise.resolve();

  const frameDocument = frames[0].contentWindow.document;
  const video = {
    readyState: 4, duration: 1_400, currentTime: 20, paused: true, muted: false,
  };
  frameDocument.video = video;
  intervals[0]();

  const style = frameDocument.getElementById("passive-viewer-restrictions").textContent;
  assert.match(style, /\.headerBackButton/);
  assert.match(style, /display:\s*none/);
  assert.match(style, /\.cold-paused-hover \.skinHeader/);
  assert.match(style, /\.cold-paused-hover \.videoOsdBottom/);
  assert.match(style, /pointer-events: auto !important/);
  assert.match(style, /z-index: 1001 !important/);
  assert.doesNotMatch(style, /^\s*\.skinHeader/m);
  assert.doesNotMatch(style, /^\s*\.videoOsdBottom/m);
  assert.doesNotMatch(style, /\.osdPositionSlider/);
  assert.doesNotMatch(style, /\.btnPause/);
});

test("the outer page handles hover until the TV has played the session", async () => {
  const { elements, frames, intervals, timeouts } = setup();
  const socket = FakeSocket.instances[0];
  socket.message({ type: "viewer-state", mode: "playing", sessionId: "episode-1", paused: true });
  await Promise.resolve();
  await Promise.resolve();

  const frame = frames[0];
  const frameDocument = frame.contentWindow.document;
  const video = {
    readyState: 4, duration: 1_400, currentTime: 20, paused: true, muted: false,
  };
  frameDocument.video = video;
  intervals[0]();
  assert.equal(elements["cold-paused-hover-catcher"].hidden, false);

  elements["cold-paused-hover-catcher"].listeners.get("mousemove")();
  assert.equal(frameDocument.documentElement.classList.contains("cold-paused-hover"), true);

  timeouts.at(-1)();
  assert.equal(frameDocument.documentElement.classList.contains("cold-paused-hover"), false);

  socket.message({ type: "viewer-state", mode: "playing", sessionId: "episode-1", paused: false });
  intervals[0]();
  assert.equal(elements["cold-paused-hover-catcher"].hidden, true);
  assert.equal(frameDocument.documentElement.classList.contains("cold-paused-hover"), false);

  socket.message({ type: "viewer-state", mode: "playing", sessionId: "episode-1", paused: true });
  intervals[0]();
  assert.equal(elements["cold-paused-hover-catcher"].hidden, true);
});

test("playback mutations are rejected without blocking Jellyfin UI events", async () => {
  const { frames, intervals } = setup();
  const socket = FakeSocket.instances[0];
  socket.message({ type: "viewer-state", mode: "playing", sessionId: "episode-1", paused: true });
  await Promise.resolve();
  await Promise.resolve();

  let playCalls = 0;
  let pauseCalls = 0;
  let fastSeekCalls = 0;
  const frameDocument = frames[0].contentWindow.document;
  const video = {
    tagName: "VIDEO",
    readyState: 4, duration: 1_400, currentTime: 20, paused: true, muted: false,
    play() { playCalls += 1; this.paused = false; return Promise.resolve(); },
    pause() { pauseCalls += 1; this.paused = true; },
    fastSeek(value) { fastSeekCalls += 1; this.currentTime = value; },
  };
  frameDocument.video = video;
  intervals[0]();

  await video.play();
  video.pause();
  video.fastSeek(600);
  video.currentTime = 500;
  assert.equal(playCalls, 0);
  assert.equal(pauseCalls, 0);
  assert.equal(fastSeekCalls, 0);
  assert.equal(video.currentTime, 20);

  const videoClick = {
    target: video,
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
  };
  frameDocument.dispatch("click", videoClick);
  assert.equal(videoClick.immediatePropagationStopped, true, "the video surface cannot toggle playback");

  for (const [eventName, key] of [["pointerdown"], ["click"], ["change"], ["keydown", "ArrowRight"]]) {
    const event = {
      key,
      target: new FakeElement(),
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    };
    frameDocument.dispatch(eventName, event);
    assert.equal(event.defaultPrevented, undefined, `${eventName} should reach Jellyfin`);
    assert.equal(event.immediatePropagationStopped, undefined, `${eventName} should reach Jellyfin`);
  }
});
