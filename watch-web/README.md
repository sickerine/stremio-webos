# Watch Web

A browser-side, TV-led watch party. Open one link and the page plays what the TV
plays, in sync, with full subtitle and track support. The browser fetches the
stream straight from the TorBox CDN and does all the media work itself. The only
server is a tiny relay.

This is the modern-browser successor to `../watch-lite` (which leaned on the TV's
own pipeline) and `../watch-party` (Jellyfin). It shares nothing with the webOS
code: a 2026 desktop browser has none of the webOS Chrome 68 limits.

## Architecture

```
TorBox CDN ──(HTTP Range, from the browser)──► mediabunny demux ──► fragmented MP4 ──► MediaSource
                                            └─► matroska-subtitles ──► jassub (ASS) / <track> (SRT)
LG TV ──(play/pause/seek/position)──► relay ──(WebSocket)──► browser follow loop
```

- **Video/audio**: `mediabunny` reads the MKV lazily over Range requests and
  re-packages the selected video + audio tracks as fragmented MP4 into a
  `MediaSource`, copying codecs (no re-encode). The file's own timestamps are
  kept, so a TV position maps 1:1 and seeking is exact.
- **Subtitles**: `matroska-subtitles` tees off the same downloaded bytes. ASS/SSA
  goes to `jassub` (libass in WASM) with the file's embedded fonts; SRT/VTT goes
  to a native `<track>`. Switching tracks is instant.
- **Follow the TV**: position only. A stalled TV never pauses the browser.
- **The relay** (`server/`): resolves the torrentio → TorBox → CDN redirect chain
  once (the middle hop has no CORS header, so a page can't) and relays TV state.
  No media passes through it.

## What works (verified against real TorBox streams)

- H.264 and HEVC video, including 4K HEVC 10-bit HDR (hardware-decoded).
- Dolby (AC-3/E-AC-3) and DTS audio, decoded and re-encoded to stereo Opus in-browser.
- Styled ASS subtitles with embedded fonts, in Chrome and Firefox.
- Many subtitle tracks; instant switching; SRT and ASS.
- Multiple audio tracks (AAC/FLAC/Opus/MP3); instant switching.
- Exact seek and pause/play follow; sub-second sync.

## Known gaps

- **TrueHD** audio: no in-browser decoder yet (AC-3, E-AC-3, DTS are handled).
- **Files with no seek index** (rare 4K x264 remuxes): seeking scans the file and
  stalls; needs a read budget + graceful fallback.
- **CJK subtitle dialogue** needs a bundled CJK fallback font; embedded fonts cover
  styling and signs but not full CJK dialogue.
- **Hi10P** (10-bit H.264, old fansubs): no hardware decode anywhere.


## Deploy (Docker + Tailscale HTTPS)

```sh
docker compose up --build -d          # relay + app on :3211
tailscale serve --bg --https=10443 3211
```

Open `https://<your-machine>.<tailnet>.ts.net:10443/?room=home`. HTTPS matters:
WebCodecs (the Opus transcode for Dolby/DTS) needs a secure context, so a plain
`http://LAN-IP` link plays anime (copy path) but not movie Dolby audio. The
Tailscale HTTPS link makes every feature work for every viewer on the tailnet.

Point the TV bridge at the relay:

```js
localStorage.setItem('watchPartyEnabled', '1');
localStorage.setItem('watchPartyUrl', 'ws://YOUR_MACHINE_IP:3211/ws');
```

## Run

```sh
npm install
npm run build
npm start                 # relay + built app on :3211
# open http://localhost:3211/?room=home
# ISOLATE=1 npm start     # cross-origin isolation for threaded libass
```

Point the TV bridge at `ws://YOUR_IP:3211/ws`.

## Test

```sh
npm test                                    # pure logic (sync, relay, byte source)
node scripts/tv-sim.mjs                      # a TV simulator (URL=... POS=... PAUSED=1)
node scripts/pw-diag.mjs <url> [s] [chromium|firefox]   # browser diagnostics
```
