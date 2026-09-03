# TV-led watch party research

Research snapshot: 2026-09-03. This is a design note only. No TV or application code was changed.

## Short answer

There is no turnkey service that can observe an arbitrary Stremio session on an LG TV, republish its current torrent or debrid stream, and make the TV the playback authority.

The closest reusable base is [OpenTogetherTube](https://github.com/dyc3/opentogethertube). It already has rooms, real-time synchronization, roles, HLS and DASH browser players, chat, reconnect handling, and a Docker deployment. It does not relay media. Its custom media inputs must resolve to public browser-playable HTTPS URLs, and its custom subtitle format is WebVTT only. [Its media manifest contract documents those limits](https://github.com/dyc3/opentogethertube/blob/master/docs/custom-media-format.md).

Recommended first version:

1. Self-host OpenTogetherTube as the room website and synchronization server.
2. Add a small outbound TV bridge to this app. The TV joins as the only client allowed to change playback.
3. Put a media gateway on a computer, NAS, or public server. The gateway converts the selected Stremio stream into an authenticated HLS VOD URL for browser viewers.
4. Leave the TV's current playback path alone initially. Map the TV time to the HLS time explicitly.

The TV stays authoritative, but it should not host the public website or accept inbound Internet connections.

## Proposed shape

```text
LG TV Stremio app
  | outbound WSS: source, play, pause, seek, progress, buffering
  v
Room server and website
  |                         |
  | room state              | server-side source descriptor
  v                         v
Browser clients       Media gateway
  ^                         |
  | authenticated HLS VOD  |
  +-------------------------+
```

The TV opens one outbound secure WebSocket. That works through normal home NAT and does not require opening the TV to the Internet. Browser clients also connect to the room server over WebSocket. WebRTC is unnecessary for this control channel.

The media gateway receives the original Stremio stream descriptor, not just the TV's loopback URL. A Stremio stream can be a direct `url` or a torrent `infoHash` plus `fileIdx`, according to the [Stremio Addon SDK stream contract](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md). A URL such as `127.0.0.1:11470/...` or `127.0.0.1:11474/...` only exists on the TV and is useless to a remote browser.

The existing app already has most of the TV observation seam:

- [`service/overlay/ass-controller.js`](../service/overlay/ass-controller.js) owns the active `<video>` and has a clock that copes with webOS's coarse `currentTime` updates and stalls.
- The same file exposes `window.__stremioCurrentMedia()`, which unwraps the local ASS tee and returns the real media URL.
- [`service/launch.js`](../service/launch.js) already proxies the bundled Stremio streaming server and contains the FFmpeg-backed HLS path.
- The generated player patch sees the original `r.stream` object before assigning the final video URL. A future bridge should capture that object there so torrent identity is not lost.

DRY implementation note: move the existing `MediaClock` into one shared module used by ASS rendering and watch-party telemetry. Do not add a second clock or another independent search for the active video element.

## What the browser should play

Use [hls.js](https://github.com/video-dev/hls.js) directly for the first viewer. It is small, controls the standard `<video>` element, supports HLS through Media Source Extensions, and falls back to native HLS where available. It also exposes the buffering and level events needed for synchronization diagnostics. Its official README states that every HLS resource needs CORS headers and warns that HLS transcoding can shift the first frame's timestamp. It gives an explicit `tOffset` correction for seeking and displayed time. That offset matters when the TV plays the original file while viewers play HLS.

[Shaka Player](https://github.com/shaka-project/shaka-player) is the better choice only if this grows to require DASH, DRM, or a more involved adaptive-streaming stack. Its [basic usage](https://shaka-project.github.io/shaka-player/docs/api/tutorial-basic-usage.html) still wraps a normal media element, so it does not remove the need for our room protocol or gateway.

[Video.js HTTP Streaming](https://github.com/videojs/http-streaming) is an optional ready-made control UI around HLS and DASH. It adds no useful synchronization capability. OpenTogetherTube already supplies a complete viewer UI, so adding Video.js on top of it would duplicate work.

Anime streams make a media gateway necessary:

- Browser-ready H.264/AAC MP4 or HLS can pass through. The gateway still hides signed upstream URLs and supplies consistent CORS and authorization.
- Matroska, HEVC, H.264 Hi10P, unsupported audio, or other browser-incompatible combinations need remuxing or transcoding to H.264/AAC HLS.
- Embedded ASS subtitles are not covered by OpenTogetherTube's WebVTT-only custom manifest. For plain dialogue, the gateway can emit WebVTT. For typeset anime, reuse this project's JASSUB renderer and ASS extraction code in a custom viewer, or burn subtitles into a compatibility rendition.
- A raw torrent must be resolved by a server-side torrent engine. Browsers should never receive only `infoHash` and be expected to reproduce Stremio's local stream. The current bundled Stremio server may be usable on a companion host. [stremio-native/stream-server](https://github.com/stremio-native/stream-server) is a young MIT-licensed alternative that advertises Stremio-compatible torrent, Range, and HLS endpoints, but it needs a real compatibility and load test before adoption.

## Synchronization protocol

OpenTogetherTube's current implementation is a useful starting point. Its server keeps `isPlaying`, `playbackPosition`, `playbackSpeed`, and a playback start timestamp. The client calculates the moving target time and checks it every 250 ms, then hard-seeks when drift exceeds one second. See its [server timestamp calculation](https://github.com/dyc3/opentogethertube/blob/497913516172917b8ff9a0088d0fb52553684750/common/timestamp.ts) and [browser correction loop](https://github.com/dyc3/opentogethertube/blob/497913516172917b8ff9a0088d0fb52553684750/client/src/views/Room.vue#L401-L450).

For this app, the TV should publish:

```json
{
  "sessionId": "new-for-each-video-load",
  "sourceRevision": 12,
  "sequence": 381,
  "positionSeconds": 734.52,
  "paused": false,
  "playbackRate": 1,
  "sampledAtServerMs": 1788462000000,
  "buffering": false
}
```

Send immediately on source change, play, pause, seek start, seek completion, rate change, waiting, playing, and end. While playing, send a one-second heartbeat. `sourceRevision` and `sequence` prevent a delayed event from an old episode or pre-seek state from overwriting the current state.

On the viewer:

1. Estimate the TV position from the last sample and the server-adjusted clock.
2. Hard-seek after a large error or any explicit TV seek.
3. Use a small temporary `playbackRate` adjustment for moderate drift, then return to `1.0`.
4. Do nothing inside a small dead band to avoid constant corrections.
5. Pause or show "TV is buffering" when the TV reports a stall. A viewer that is buffering reports status but never changes room state.

The exact drift thresholds need measurement on two real remote networks. OpenTogetherTube's one-second hard-seek threshold is a defensible initial baseline, not a proven value for this TV.

The browser must also have a "Join and enable audio" action. The HTML standard allows `play()` to reject with `NotAllowedError` when playback has not been unlocked by user interaction. See the [media element play algorithm](https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource).

## Ready-made options

| Option | Reuse | Why it is or is not the answer |
| --- | --- | --- |
| [OpenTogetherTube](https://github.com/dyc3/opentogethertube) | Yes, recommended base | It already plays HLS VOD, DASH VOD, HTTP MP4, and custom manifests, with room permissions and real-time sync. Its [self-host guide](https://github.com/dyc3/opentogethertube/blob/master/docs/how-to-deploy.md) uses Docker Compose with Redis and PostgreSQL and requires HTTPS plus WebSocket proxying. We still need the TV bridge and media gateway. It is AGPL-3.0, so a modified hosted fork must keep the corresponding source available under that license. |
| [Jellyfin SyncPlay](https://jellyfin.org/posts/jellyfin-10-6-0/) | Only if Jellyfin replaces the media plane | Jellyfin has rooms and synchronized clients. Its server exposes group pause, unpause, seek, buffering, and ready endpoints in the official [SyncPlay controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/SyncPlayController.cs). The current TV app is not a Jellyfin client and arbitrary Stremio addon streams are not Jellyfin library items. Adapting it would amount to a new Jellyfin client and ingestion path. |
| [Syncplay](https://github.com/Syncplay/syncplay) | No | It controls supported desktop players such as mpv and VLC, and its own README says it is not a file-sharing service. It does not provide the browser website or media delivery. |
| [MediaMTX](https://mediamtx.org/docs/kickoff/introduction) | Possible live media component | It routes live streams and can expose HLS or WebRTC to browsers. It does not supply rooms or TV-led VOD state. [Its browser guide](https://mediamtx.org/docs/read/web-browsers) says HLS is easier to connect but has higher latency than WebRTC. The TV would still need a publisher or FFmpeg bridge. |
| [OvenMediaEngine](https://github.com/OvenMediaLabs/OvenMediaEngine) | No for the first version | It ingests live protocols, has an embedded transcoder, and publishes WebRTC or low-latency HLS at large scale. This is much heavier than a small private VOD watch party and still does not observe the Stremio TV player. |
| [Owncast](https://owncast.online/docs/video/) | No | It is an RTMP-to-HLS live broadcast server. Its docs explicitly say HLS will not reach conferencing-style sub-second latency. It has no arbitrary VOD seek model, so a TV seek would require restarting or repositioning the broadcast pipeline. |

MediaMTX or OvenMediaEngine makes sense only if the product changes into "broadcast the TV's playback as a live channel." That gives low-delay spectators but loses clean arbitrary seeking. It also introduces WebRTC ICE, public UDP or TCP ports, STUN, and often TURN. MediaMTX documents the [NAT and TURN setup](https://mediamtx.org/docs/features/webrtc-specific-features). For a TV-led VOD room, HTTPS HLS plus WebSocket control is simpler and more reliable.

## Hosting, CORS, authentication, and bandwidth

- Host the room website, WebSocket endpoint, manifests, segments, and subtitles on one HTTPS origin when possible. This avoids most CORS and cookie problems.
- If media uses another origin, every playlist, segment, key, and text track needs the right CORS response. hls.js requires CORS for all HLS resources.
- Issue a short-lived room token. Exchange it for short-lived media URLs or an HttpOnly same-origin session. Do not send debrid credentials or the original signed source URL to viewers.
- If HLS requests need a bearer token, hls.js supports custom request setup in its [API configuration](https://github.com/video-dev/hls.js/blob/master/docs/API.md#xhrsetup).
- A public VPS avoids residential NAT, but it pays the inbound source bandwidth once and viewer egress once per viewer unless a CDN caches HLS segments. A home gateway needs an HTTPS reverse proxy or outbound tunnel and enough upload for all viewers.
- Keep each media session immutable. A new episode or stream selection gets a new `sessionId`, manifest path, and synchronization epoch. This prevents cached segments or late events from crossing episode boundaries.

## Suggested proof sequence

1. Self-host OpenTogetherTube unchanged and prove that one HLS VOD URL plays and follows its normal room sync.
2. Add the TV as a restricted controller client. Test play, pause, seek, buffering, stream replacement, next episode, and reconnect.
3. Add a same-origin gateway for one direct debrid MKV. Verify codec conversion, Range behavior, signed-URL expiry, CORS, HLS timestamp offset, audio selection, and subtitles.
4. Add the torrent `infoHash` and `fileIdx` route. Test a single-file torrent and a multi-episode pack, including seeking into pieces that have not downloaded yet.
5. Test two remote browsers on different networks for at least one full episode before tuning the drift thresholds.

The first go/no-go prototype should use OpenTogetherTube plus hls.js and a single server-side gateway. Do not start with WebRTC, MediaMTX, OvenMediaEngine, or a new player UI.
