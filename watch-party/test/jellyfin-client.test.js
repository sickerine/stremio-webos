import assert from "node:assert/strict";
import { test } from "node:test";

import { createJellyfinClient } from "../src/jellyfin-client.js";

function jsonResponse(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { "content-type": "application/json" },
  });
}

test("initialization completes a fresh server, authenticates, and enables English subtitles", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ StartupWizardCompleted: false }), jsonResponse({ Name: "" }),
    jsonResponse(null, 204), jsonResponse(null, 204), jsonResponse(null, 204), jsonResponse(null, 204),
    jsonResponse({ AccessToken: "token", User: { Id: "user-id", Configuration: { SubtitleMode: "Default" } } }),
    jsonResponse(null, 204), jsonResponse([]), jsonResponse(null, 204),
  ];
  const client = createJellyfinClient({
    baseUrl: "http://jellyfin.test", username: "viewer", password: "secret",
    fetchImplementation: async (url, options) => { calls.push({ url, options }); return responses.shift(); },
  });
  await client.initialize();

  assert.equal(calls[0].url, "http://jellyfin.test/System/Info/Public");
  assert.equal(calls[6].url, "http://jellyfin.test/Users/AuthenticateByName");
  assert.match(calls[6].options.headers.get("authorization"), /DeviceId="stremio-tv-bridge"/);
  assert.equal(calls[7].options.headers.get("x-emby-token"), "token");
  const userConfiguration = JSON.parse(calls[7].options.body);
  assert.equal(userConfiguration.SubtitleMode, "Always");
  assert.equal(userConfiguration.SubtitleLanguagePreference, "eng");
  assert.equal(userConfiguration.RememberSubtitleSelections, true);
});

test("browser sessions receive direct play, pause, resume, and seek commands", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ StartupWizardCompleted: true }),
    jsonResponse({ AccessToken: "token", User: { Id: "user-id", Configuration: {} } }),
    jsonResponse(null, 204), jsonResponse([{ Name: "Watch Party" }]),
    jsonResponse([
      {
        Id: "browser-1", Client: "Jellyfin Web", SupportsRemoteControl: true,
        NowPlayingItem: null, PlayState: { IsPaused: false, CanSeek: true },
      },
      { Id: "bridge", Client: "Stremio TV Bridge", SupportsRemoteControl: false },
    ]),
    jsonResponse(null, 204),
    jsonResponse([
      {
        Id: "browser-1", Client: "Jellyfin Web", SupportsRemoteControl: true,
        NowPlayingItem: { Id: "item-id" },
        PlayState: { PositionTicks: 100_000_000, IsPaused: false, CanSeek: true },
      },
    ]),
    jsonResponse(null, 204), jsonResponse(null, 204),
    jsonResponse([
      {
        Id: "browser-1", Client: "Jellyfin Web", SupportsRemoteControl: true,
        NowPlayingItem: { Id: "item-id" },
        PlayState: { PositionTicks: 802_500_000, IsPaused: true, CanSeek: true },
      },
    ]),
    jsonResponse(null, 204),
  ];
  const client = createJellyfinClient({
    baseUrl: "http://jellyfin.test",
    fetchImplementation: async (url, options) => { calls.push({ url, options }); return responses.shift(); },
  });
  await client.initialize();
  assert.equal(await client.syncViewers("item-id", { positionSeconds: 12.345, paused: false }), 1);
  await client.syncViewers("item-id", { positionSeconds: 80.25, paused: true }, {
    actions: ["seek", "pause"], checkDrift: true,
  });
  await client.syncViewers("item-id", { positionSeconds: 80.25, paused: false }, {
    actions: ["unpause"], checkDrift: false,
  });

  const playCall = calls.find(call => call.url.includes("/Sessions/browser-1/Playing?"));
  assert.match(playCall.url, /playCommand=PlayNow/);
  assert.match(playCall.url, /startPositionTicks=123450000/);
  assert.ok(calls.some(call => call.url.endsWith("/Sessions/browser-1/Playing/Pause")));
  assert.ok(calls.some(call => call.url.endsWith("/Sessions/browser-1/Playing/Unpause")));
  assert.ok(calls.some(call => call.url.endsWith("/Sessions/browser-1/Playing/Seek?seekPositionTicks=802500000")));
  assert.equal(calls.some(call => call.url.includes("SyncPlay") || call.url.includes("Buffering")), false);
});

test("a browser item is started once even while loading or after playback ends", async () => {
  const calls = [];
  const browserWithoutPlayback = {
    Id: "browser-1", Client: "Jellyfin Web", SupportsRemoteControl: true,
    NowPlayingItem: null, PlayState: { IsPaused: false, CanSeek: true },
  };
  const browserPlayingItemA = {
    ...browserWithoutPlayback,
    NowPlayingItem: { Id: "item-a" },
  };
  const responses = [
    jsonResponse({ StartupWizardCompleted: true }),
    jsonResponse({ AccessToken: "token", User: { Id: "user-id", Configuration: {} } }),
    jsonResponse(null, 204), jsonResponse([{ Name: "Watch Party" }]),
    jsonResponse([browserWithoutPlayback]), jsonResponse(null, 204),
    jsonResponse([browserWithoutPlayback]),
    jsonResponse([browserPlayingItemA]),
    jsonResponse([browserWithoutPlayback]),
    jsonResponse([browserWithoutPlayback]), jsonResponse(null, 204),
  ];
  const client = createJellyfinClient({
    baseUrl: "http://jellyfin.test",
    fetchImplementation: async (url, options) => { calls.push({ url, options }); return responses.shift(); },
  });
  await client.initialize();

  await client.syncViewers("item-a", { positionSeconds: 10, paused: false });
  await client.syncViewers("item-a", { positionSeconds: 11, paused: false });
  await client.syncViewers("item-a", { positionSeconds: 12, paused: false });
  await client.syncViewers("item-a", { positionSeconds: 1_430, paused: true });
  await client.syncViewers("item-b", { positionSeconds: 0, paused: false });

  const playCalls = calls.filter(call => call.url.includes("playCommand=PlayNow"));
  assert.equal(playCalls.length, 2);
  assert.match(playCalls[0].url, /itemIds=item-a/);
  assert.match(playCalls[1].url, /itemIds=item-b/);
});
