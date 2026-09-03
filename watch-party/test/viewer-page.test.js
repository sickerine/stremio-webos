import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrowserDeviceId, createPassiveViewer, isBlockedPlaybackKey } from "../public/viewer.js";

class FakeElement {
  constructor() {
    this.hidden = false;
    this.children = [];
    this.style = {};
    this.listeners = new Map();
    this.dataset = {};
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
}

class FakeFrameDocument {
  constructor() {
    this.head = new FakeElement();
    this.listeners = new Map();
    this.sliders = [];
    this.video = null;
  }
  getElementById(id) { return this.head.children.find(child => child.id === id) || null; }
  createElement() { return new FakeElement(); }
  querySelector(selector) { return selector === "video" ? this.video : null; }
  querySelectorAll(selector) { return selector === ".osdPositionSlider" ? this.sliders : []; }
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
  assert.equal(elements.player.children.length, 0);
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

test("TV idle cancels an unfinished player bootstrap", async () => {
  let finishBootstrap;
  const bootstrapPromise = new Promise(resolve => { finishBootstrap = resolve; });
  const { elements, frames, bootstrap } = setup({ bootstrapPromise });
  const socket = FakeSocket.instances[0];
  socket.message({ type: "viewer-state", mode: "playing", sessionId: "episode-1", title: "Episode 1" });
  socket.message({ type: "viewer-state", mode: "waiting" });
  finishBootstrap(bootstrap);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(frames.length, 0);
  assert.equal(elements.waiting.hidden, false);
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
  const video = {
    readyState: 4, duration: 1_400, currentTime: 20, paused: false, muted: false,
    pause() { pauseCalls += 1; this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
  frames[0].contentWindow.document.querySelector = selector => selector === "video" ? video : null;
  intervals[0]();
  assert.ok(video.currentTime >= 30 && video.currentTime < 30.1);

  socket.message({
    type: "viewer-state", mode: "playing", sessionId: "episode-1",
    paused: true, positionSeconds: 45,
  });
  intervals[0]();
  assert.equal(video.currentTime, 45);
  assert.equal(video.paused, true);
  assert.equal(pauseCalls, 1);
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

test("the passive player blocks every normal seek route but leaves track menus interactive", async () => {
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

  const slider = new FakeElement();
  slider.matches = selector => selector === ".osdPositionSlider";
  slider.closest = selector => selector === ".osdPositionSlider" ? slider : null;
  slider.classList = { remove(name) { slider.removedClass = name; } };
  frameDocument.sliders.push(slider);
  intervals[0]();

  assert.equal(slider.tabIndex, -1);
  assert.equal(slider["aria-disabled"], "true");
  assert.equal(slider.removedClass, "focusable");
  assert.match(
    frameDocument.getElementById("passive-viewer-restrictions").textContent,
    /\.osdPositionSlider/,
  );

  const seekEvent = {
    target: slider,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
  };
  frameDocument.dispatch("pointerdown", seekEvent);
  assert.equal(seekEvent.defaultPrevented, true);
  assert.equal(seekEvent.immediatePropagationStopped, true);

  const trackMenuButton = {
    matches: () => false,
    closest: () => null,
  };
  const trackMenuEvent = {
    target: trackMenuButton,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
  };
  frameDocument.dispatch("click", trackMenuEvent);
  assert.equal(trackMenuEvent.defaultPrevented, undefined);
  assert.equal(trackMenuEvent.immediatePropagationStopped, undefined);

  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "0", "5", "9", "NavigationLeft", "GamepadDPadRight"]) {
    const keyEvent = {
      key,
      target: trackMenuButton,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    };
    frameDocument.dispatch("keydown", keyEvent);
    assert.equal(keyEvent.defaultPrevented, true, `${key} should not seek`);
  }
});

test("the blocked key list covers Jellyfin keyboard and TV-navigation seeks", () => {
  for (const key of ["j", "l", "PageUp", "PageDown", "Home", "End", "0", "9", "NavigationLeft", "NavigationRight"]) {
    assert.equal(isBlockedPlaybackKey(key), true, key);
  }
  for (const key of ["a", "s", "Enter", "Escape"]) {
    assert.equal(isBlockedPlaybackKey(key), false, key);
  }
});
