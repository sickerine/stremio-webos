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
# WATCH_PASSWORD=... npm start   # shared password; browsers get a permanent cookie, the TV socket is exempt
```

Point the TV bridge at `ws://YOUR_IP:3211/ws`.

## Test

```sh
npm test                                    # pure logic (sync, relay, byte source)
node scripts/tv-sim.mjs                      # a TV simulator (URL=... POS=... PAUSED=1)
node scripts/pw-diag.mjs <url> [s] [chromium|firefox]   # browser diagnostics
npm run build && node scripts/pw-e2e.mjs    # a real browser follows a fake TV: sound, a skip, a flickering start (needs ffmpeg)
```

## Watch in VLC (Windows)

A viewer on Windows can follow the TV in VLC instead of the browser. VLC plays the
stream itself, so sound and subtitles are VLC's own. The control bar shows a VLC
button on Windows; it leads to `/vlc`, which hands out `Watch party in VLC.cmd`.
That file is `server/vlc-follow.ps1` with this relay's address, the room and the
sign-in filled in. Opening it starts VLC (installing it with winget if needed) and
keeps it on the TV's position until VLC is closed.

How it follows:

- It joins the room as a viewer, on the same socket and with the same clock pairing
  as the browser page, and opens the CDN link the relay resolved.
- VLC runs with its web interface on a random local port and password. One small Lua
  page there reports the exact position (the stock status page rounds it to whole
  seconds) and how full VLC's buffer is.
- A gap up to half a second is closed by changing VLC's speed by at most 8%. For a
  larger one VLC is parked, paused, a little ahead of the TV and let go as the TV
  arrives, once its buffer is full. A new episode opens the same way. Chasing with
  repeated seeks does not work: VLC reports the new position before it can play it.
- While the TV is paused or loading, VLC sits on the TV's frame.
- A stream that stops or hangs is opened again through the TV's own link, which
  still works after the CDN link has expired.
- It reports back every five seconds, so `docker logs stremio-watch-web | grep netlog`
  shows how each VLC viewer is doing (`"client":"vlc"`).

Measured on Windows 11 with VLC 3.0.24:

- Against a fake TV on the LAN: median gap 12 to 25 ms, a pause within one frame of
  the TV's, a new episode in step from its first frame without a seek. In screenshots
  of the desktop the picture was within one frame of the TV's position.
- Through the public relay (93 ms round trip) with an episode from TorBox: typical
  gap 11 ms, 23 to 41 ms off right after a jump. A jump takes 2 to 4 s, because
  TorBox needs 1.3 to 2.4 s to fill VLC's buffer after a seek. Opening a file with
  42 MB of attached fonts took 13 s.
- VLC keeps one connection to the CDN. On a seek the old and the new one overlap:
  under 20 ms on a LAN, up to 2 s on TorBox.

It is a downloaded file, not a pasted command, because Windows Defender blocks
`powershell ... "irm <url> | iex"` as a trojan (Trojan:Win32/Commando.B!ml). Windows
asks once whether to run the file ("The publisher could not be verified"). A file
from before a relay update or a password change says so and asks to be downloaded
again.

In the party window VLC's keyboard shortcuts for pause, seek and speed are switched
off (Space, the arrow keys with and without modifiers, the speed keys, S, N, E). They
are launch options: nothing is saved, and the viewer's own VLC keeps its keys. The
buttons on VLC's bar and its menus still respond, but nothing a viewer does there
sticks: a pause is undone in under a second, a speed change in about one, a seek, a
Stop, or another file opened in the window in two to four (measured by doing each
through VLC's control page).
The stream does show up in VLC's own "Open Recent Media" list. VLC's switch for that
(`--no-qt-recentplay`) is not used, because it also wipes the viewer's saved list.

Settings, as environment variables set before opening the file:

- `WATCH_CDN_HOST`: read the stream from this CDN node instead of the one in the
  link. Needed for a viewer on the same network as the TV: two players on one address
  reading from one TorBox node get that address banned for about two hours.
- `WATCH_OFFSET_MS`: play this much later than the TV (negative: earlier).
- `WATCH_VLC_ARGS`: extra VLC arguments, for example `--fullscreen`.
- `WATCH_DEBUG=1`: log every reading to `%TEMP%\watch-party-vlc\follow.log`.

Check it end to end (ffmpeg here, VLC on the Windows side; a relay and a fake TV run
in the script):

```sh
node scripts/vlc-e2e.mjs                      # on Windows
SSH=<windows host> node scripts/vlc-e2e.mjs   # from another machine
```

## Public hostname (watch.khaslana.me)

The zone is on Cloudflare DNS and a named tunnel (`watch`) carries the traffic; quick tunnels
(`cloudflared tunnel --url`) would get a new random name every run. Setup, once per machine:

    cloudflared tunnel login                       # browser authorisation, writes ~/.cloudflared/cert.pem
    cloudflared tunnel create watch                # writes ~/.cloudflared/<id>.json
    cloudflared tunnel route dns watch watch.khaslana.me
    mkdir -p cloudflared && cp ~/.cloudflared/<id>.json cloudflared/credentials.json
    # cloudflared/config.yml: tunnel <id>, credentials-file, ingress watch.khaslana.me -> http://watch-web:3211
    echo COMPOSE_PROFILES=tunnel >> .env && docker compose up -d

`cloudflared/` is git-ignored (it holds the tunnel credentials).
