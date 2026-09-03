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

test("SyncPlay commands use ticks and never send buffering commands", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ StartupWizardCompleted: true }),
    jsonResponse({ AccessToken: "token", User: { Id: "user-id", Configuration: {} } }),
    jsonResponse(null, 204), jsonResponse([{ Name: "Watch Party" }]),
    jsonResponse([]), jsonResponse(null, 204), jsonResponse(null, 204),
    jsonResponse(null, 204), jsonResponse(null, 204), jsonResponse(null, 204), jsonResponse(null, 204),
  ];
  const client = createJellyfinClient({
    baseUrl: "http://jellyfin.test",
    fetchImplementation: async (url, options) => { calls.push({ url, options }); return responses.shift(); },
  });
  await client.initialize();
  await client.ensureGroup("home");
  await client.setQueue("item-id", 12.345);
  await client.pause();
  await client.unpause();
  await client.seek(80.25);

  assert.ok(calls.some(call => call.url.endsWith("/SyncPlay/New")));
  const queueCall = calls.find(call => call.url.endsWith("/SyncPlay/SetNewQueue"));
  assert.equal(JSON.parse(queueCall.options.body).StartPositionTicks, 123_450_000);
  assert.ok(calls.some(call => call.url.endsWith("/SyncPlay/Pause")));
  assert.ok(calls.some(call => call.url.endsWith("/SyncPlay/Unpause")));
  const seekCall = calls.find(call => call.url.endsWith("/SyncPlay/Seek"));
  assert.equal(JSON.parse(seekCall.options.body).PositionTicks, 802_500_000);
  assert.equal(calls.some(call => call.url.includes("Buffering")), false);
});
