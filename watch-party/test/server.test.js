import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import WebSocket from "ws";

import { createWatchPartyServer } from "../src/server.js";

const openServers = [];
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    force: true,
    recursive: true,
  })));
});

async function startServer(options = {}) {
  const server = createWatchPartyServer(options);
  await server.listen(0, "127.0.0.1");
  openServers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 1000);
    const onMessage = data => {
      const message = JSON.parse(data.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

test("health endpoint reports that the watch-party service is ready", async () => {
  const origin = await startServer();
  const response = await fetch(`${origin}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "stremio-watch-party",
  });
});

test("viewer page and local hls.js player assets are served", async () => {
  const origin = await startServer();
  const page = await fetch(`${origin}/?room=home`);
  const html = await page.text();

  assert.equal(page.status, 200);
  assert.match(html, /<video[^>]+id="player"/);
  assert.match(html, /src="\/vendor\/hls\.min\.js"/);
  assert.match(html, /src="\/app\.js"/);

  const hls = await fetch(`${origin}/vendor/hls.min.js`);
  assert.equal(hls.status, 200);
  assert.match(hls.headers.get("content-type"), /javascript/);

  const app = await fetch(`${origin}/app.js`);
  assert.equal(app.status, 200);
  assert.match(await app.text(), /new WebSocket/);
});

test("TV state is broadcast to viewers and stale sequence numbers are ignored", async () => {
  const origin = await startServer();
  const wsOrigin = origin.replace("http", "ws");
  const viewer = await connect(`${wsOrigin}/ws?room=living-room&role=viewer`);
  const tv = await connect(`${wsOrigin}/ws?room=living-room&role=tv`);
  const stateMessage = nextMessage(viewer, "room-state");

  tv.send(JSON.stringify({
    type: "state",
    state: {
      sessionId: "bleach-3",
      sequence: 2,
      positionSeconds: 42.5,
      paused: false,
      playbackRate: 1,
      buffering: false,
      durationSeconds: 1440,
    },
  }));

  const broadcast = await stateMessage;
  assert.equal(broadcast.state.sessionId, "bleach-3");
  assert.equal(broadcast.state.sequence, 2);
  assert.equal(broadcast.state.positionSeconds, 42.5);

  tv.send(JSON.stringify({
    type: "state",
    state: {
      sessionId: "bleach-3",
      sequence: 1,
      positionSeconds: 10,
      paused: true,
    },
  }));

  const response = await fetch(`${origin}/api/rooms/living-room`);
  const snapshot = await response.json();
  assert.equal(snapshot.state.sequence, 2);
  assert.equal(snapshot.state.positionSeconds, 42.5);

  viewer.close();
  tv.close();
});

test("viewers cannot replace the TV's room state", async () => {
  const origin = await startServer();
  const viewer = await connect(`${origin.replace("http", "ws")}/ws?room=home&role=viewer`);
  const errorMessage = nextMessage(viewer, "error");

  viewer.send(JSON.stringify({
    type: "state",
    state: { sessionId: "fake", sequence: 1, positionSeconds: 900 },
  }));

  assert.equal((await errorMessage).code, "viewer-read-only");
  const snapshot = await (await fetch(`${origin}/api/rooms/home`)).json();
  assert.equal(snapshot.state, null);

  viewer.close();
});

test("a new TV source starts one media job and publishes its browser playback URL", async () => {
  const prepareCalls = [];
  const releaseCalls = [];
  const mediaManager = {
    prepare(state, publish) {
      prepareCalls.push(state);
      publish({
        status: "ready",
        sessionId: state.sessionId,
        playbackUrl: `/media/${state.sessionId}/master.m3u8`,
        offsetSeconds: 30,
      });
    },
    release(sessionId) { releaseCalls.push(sessionId); },
    close() {},
  };
  const origin = await startServer({ mediaManager });
  const wsOrigin = origin.replace("http", "ws");
  const viewer = await connect(`${wsOrigin}/ws?room=home&role=viewer`);
  const tv = await connect(`${wsOrigin}/ws?room=home&role=tv`);
  const mediaMessage = nextMessage(viewer, "media-state");

  const state = {
    sessionId: "episode-7",
    sequence: 1,
    positionSeconds: 36,
    paused: false,
    mediaUrl: "https://media.example/episode-7.mkv",
  };
  tv.send(JSON.stringify({ type: "state", state }));

  const media = (await mediaMessage).media;
  assert.equal(media.status, "ready");
  assert.equal(media.playbackUrl, "/media/episode-7/master.m3u8");
  assert.equal(prepareCalls.length, 1);

  tv.send(JSON.stringify({ type: "state", state: { ...state, sequence: 2, positionSeconds: 37 } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(prepareCalls.length, 1);
  assert.equal(releaseCalls.length, 0);

  const replacementMessage = nextMessage(viewer, "media-state");
  tv.send(JSON.stringify({
    type: "state",
    state: {
      ...state,
      mediaUrl: "https://media.example/episode-8.mkv",
      sessionId: "episode-8",
      sequence: 1,
    },
  }));
  await replacementMessage;
  assert.deepEqual(releaseCalls, ["episode-7"]);
  assert.equal(prepareCalls.length, 2);

  const snapshot = await (await fetch(`${origin}/api/rooms/home`)).json();
  assert.equal(snapshot.media.playbackUrl, "/media/episode-8/master.m3u8");

  viewer.close();
  tv.close();
});

test("HLS playlists and segments are served from the media session directory", async () => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "watch-party-server-"));
  const mediaKey = "0123456789abcdef01234567";
  temporaryDirectories.push(mediaRoot);
  await mkdir(path.join(mediaRoot, mediaKey));
  await writeFile(path.join(mediaRoot, mediaKey, "master.m3u8"), "#EXTM3U\n");
  await writeFile(path.join(mediaRoot, mediaKey, "segment-000001.ts"), "video-bytes");
  const origin = await startServer({ mediaRoot });

  const playlist = await fetch(`${origin}/media/${mediaKey}/master.m3u8`);
  assert.equal(playlist.status, 200);
  assert.equal(playlist.headers.get("content-type"), "application/vnd.apple.mpegurl");
  assert.equal(await playlist.text(), "#EXTM3U\n");

  const segment = await fetch(`${origin}/media/${mediaKey}/segment-000001.ts`);
  assert.equal(segment.status, 200);
  assert.equal(segment.headers.get("content-type"), "video/mp2t");
  assert.equal(await segment.text(), "video-bytes");

  const traversal = await fetch(`${origin}/media/${mediaKey}/..%2F..%2Fpackage.json`);
  assert.equal(traversal.status, 404);
});
