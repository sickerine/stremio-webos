# Watch Lite

A thin TV-led watch page. The TV stays the playback authority; this service turns
the TV's current stream into browser video and follows its play/pause/seek. No
Jellyfin, no login, no library, no group protocol.

It is a separate, self-contained alternative to `../watch-party` (the Jellyfin
build). Nothing here touches the TV.

## Why it exists

The Jellyfin build's cold start was ~24s and its per-episode restart made the
first viewer wait 30-45s, because Jellyfin re-probes every play and downloads the
whole file to extract one subtitle track. Anime torrents are almost always H.264
8-bit + AAC, which browsers play as-is, so this service **remuxes** (`-c copy`)
instead of transcoding. Copy runs at ~60x realtime, so the first video segment and
the first subtitle segment are both ready in **~7-8s** against a real TorBox
stream (measured, not estimated).

## How it works

1. The TV bridge (`service/overlay/watch-party-controller.js`) opens a WebSocket as
   `role=tv` and publishes `{ mediaUrl, positionSeconds, paused, ... }`.
2. On a new stream, `media-manager.js` starts one ffmpeg that emits an HLS TS
   playlist plus a **segmented WebVTT subtitle rendition** in the same pass.
   - It starts optimistically with `-c copy` and the first subtitle track **while
     probing in parallel**. Running the probe and the ffmpeg seek serially was the
     old ~12s; in parallel it is ~7s.
   - Only if the probe reveals incompatible video/audio (HEVC, 10-bit, FLAC, ...)
     does it restart once with a transcode.
3. The page (`public/app.js`) plays the HLS with hls.js. hls.js loads the subtitle
   rendition itself and renders cues natively. The page **follows the TV by
   position only** and never mirrors the TV's buffering as a pause (that was the
   old pause storm).

## Run

```sh
npm install
FFMPEG_BIN=$(command -v ffmpeg) FFPROBE_BIN=$(command -v ffprobe) npm start
# open http://localhost:3310/?room=home
```

Point the TV bridge at it:

```js
localStorage.setItem('watchPartyEnabled', '1');
localStorage.setItem('watchPartyUrl', 'ws://YOUR_COMPUTER_IP:3310/ws');
```

## Test

```sh
npm test                                   # pure logic: probe plan, master, sync
node scripts/e2e-cold-start.mjs "<mediaUrl>" 250   # live: real TorBox cold-start timing
node scripts/tv-sim.mjs                     # a TV simulator for browser testing
```

## Known ceilings (deliberate)

- **Subtitles are WebVTT** (dialogue, perfect timing, no ASS signs/typesetting).
  Upgrade path: reuse `service/mkv-subs.js` + JASSUB in the browser, same renderer
  the TV uses.
- **Seeking before the start offset** re-shows the offset position, not the target,
  because ffmpeg began near the TV's position at launch. Forward seeks and normal
  watching are fine; a large backward seek would need a re-prepare.
- **Transcode fallback needs a real encoder.** On the host this uses
  `h264_videotoolbox`. In Docker there is no VideoToolbox, so set
  `WATCH_LITE_VCODEC=libx264` there. Copy (the common path) needs no encoder.
