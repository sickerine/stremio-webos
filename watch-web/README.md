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

- It joins the room as a viewer, on the same socket as the browser page, and opens the
  CDN link the relay resolved. Its clock is paired with the relay's from all recent
  pings together: the quickest trip out bounds it on one side, the quickest trip back
  on the other. That holds to a few ms where a single ping can be tens off.
- VLC runs with its web interface on a random local port and password. One small Lua
  page there reports the exact position (the stock status page rounds it to whole
  seconds) and how full VLC's buffer is, and takes the follower's commands.
- Where VLC is gets worked out, not read. VLC refreshes the position it reports four
  times a second and not at all while paused, so a reading is up to 255 ms old. Each
  command moves a model of VLC by what that command is known to do, and each refresh
  then bounds how far the model is off: to 10 ms after one refresh, to 1 or 2 ms after
  a few seconds.
- A gap up to 0.3 s is closed by a burst of speed, 5% for a gap under 40 ms and 10%
  above, which ends when the model says the gap is gone. A gap under 10 ms is left
  alone, and so is one smaller than the TV's own reports can resolve.
- For a larger gap and for every new episode VLC is parked: paused ahead of the TV and
  let go at the moment the TV arrives. How far ahead follows how long seeks and opens
  have taken on this viewer's connection. Chasing with repeated seeks does not work:
  VLC reports the new position before it can play it. A seek is sent only once the
  one before it has filled VLC's buffer, whoever sent that one.
- While the TV is paused or loading, VLC waits a little past the TV's frame: as far as
  the TV gets between playing again and VLC starting on the news of it (30 to 250 ms,
  from how late the TV's reports arrive). A resume then needs no catching up, and a
  pause on the TV costs no seek.
- A stream that stops or hangs is opened again through the TV's own link, which
  still works after the CDN link has expired.
- When the connection to the relay drops, VLC plays on where the model has it, and
  the relay's first message back says what has changed.
- It reports back every five seconds, so `docker logs stremio-watch-web | grep netlog`
  shows how each VLC viewer is doing (`"client":"vlc"`).

What the timing rests on, measured on Windows 11 with VLC 3.0.24:

- VLC runs the control page 0.3 ms after a request is sent and then holds the answer
  for 20 ms. A reading belongs to the moment it was asked for, not to the middle of
  the exchange (taking the middle put everything 10 ms off).
- VLC moves 11 ms after a release is sent (8 to 12) and stops 12 ms after a pause
  (9 to 16). A speed change takes hold at once, keeps the pitch, and leaves a wave or
  two of click in the sound.
- Let go after a seek at any speed but 1, VLC starts ahead of where it was put by what
  it had buffered times (speed - 1): none, one or two seconds' worth, differently each
  time. So VLC is always paused, moved and let go at speed 1, and given the TV's speed
  or a burst in a separate command once it moves. That lands within 10 ms.
- A paused VLC shows a seek in its buffer level at once; a playing one keeps
  reporting a full buffer for tens of ms. So it is paused first, then moved.
- A paused VLC never changes the position it reports unless it is moved (not once in
  5,000 readings). That is how a viewer's seek during a pause is noticed.
- On TorBox a seek sent 40 ms after another that was still filling took 3.8 to 5.6 s;
  the same seeks sent alone took 1.0 to 2.5 s.

How it does, from `scripts/vlc-bench.mjs` (below). The gap is VLC's own reading set
against where a fake TV really was at that moment. A time runs from the end of the
disturbance to the first reading from which VLC stays within 50 ms, so it includes up
to a quarter of a second of waiting for VLC's next refresh. "Never left" means no
reading was outside the 50 ms at all.

| | LAN | stream 250 ms away, relay 40 ms | stream 1 s away at 3x bitrate | relay 150 ms away, noisy TV | live relay and TorBox |
|---|---|---|---|---|---|
| Gap while playing | -9 to 12 ms | -9 to 12 ms | -17 to 5 ms | -6 to 30 ms | -10 to 14 ms |
| Joining, from opening the stream | 0.8 s | 2.7 s | 8.5 s | 0.8 s | 5.8 s |
| TV pauses, then plays | 0.4 s | 0.4 s | 0.4 s | 0.6 s | 0.4 s |
| TV skips, loads 0.3 s | 0.3 s | 1.9 s | 4.1 s | 0.6 s | 5.1 s |
| TV skips, loads 4 s | 0.3 s | 0.3 s | 0.3 s | 0.5 s | 0.3 s |
| TV skips without loading | 0.5 s | 1.4 s | 2.8 s | 0.7 s | 2.0 s |
| TV skips while playing at 1.5x | 0.7 s | 1.4 s | 3.3 s | 0.8 s | 4.8 s |
| Viewer pauses VLC | 0.3 s | 0.3 s | 0.3 s | 0.4 s | 0.1 s |
| Viewer seeks | 0.6 s | 1.2 s | 4.7 s | 0.6 s | 4.4 s |
| Viewer seeks while the TV is paused | back before the TV plays | same | same | same | 5.2 s after it plays |
| Viewer changes the speed | never left | never left | never left | never left | never left |
| Viewer presses Stop | 1.1 s | 2.8 s | 7.8 s | 1.4 s | 6.3 s |
| Viewer opens another file | 0.9 s | 2.8 s | 7.6 s | 0.9 s | 5.9 s |
| Next episode | 0.3 s | 0.4 s | 6.2 s | 0.5 s | 7.3 s |
| Connection to the relay drops | never left | never left | never left | 1.4 s | not run |

- Over a relay 150 ms away with 60 ms of jitter each way, and a TV whose reports are
  12 ms noisy and up to 80 ms late, the gap is wider and a dropped connection costs a
  correction when the clocks are paired afresh.
- On TorBox a seek filled VLC's buffer in 0.9 to 3.0 s and opening a stream took 3.7 to
  6.1 s (the second episode had 24 MB of attached fonts). Those two set the live
  column. One seek took 9.4 s: the viewer's own, into a part of the file the CDN had
  not served, and the follower waited for it before seeking back, which is the
  5.2 s in the table. Opening a file with 42 MB of fonts took 13 s in an earlier test.
- VLC keeps one connection to the CDN. On a seek the old and the new one overlap:
  under 20 ms on a LAN, up to 2 s on TorBox.
- Not measured: the TV itself as the leader (the live column used a stand-in TV on the
  real relay), and the picture against the TV's by eye.

It is a downloaded file, not a pasted command, because Windows Defender blocks
`powershell ... "irm <url> | iex"` as a trojan (Trojan:Win32/Commando.B!ml). Windows
asks once whether to run the file ("The publisher could not be verified"). A file
from before a relay update or a password change says so and asks to be downloaded
again.

In the party window VLC's keyboard shortcuts for pause, seek and speed are switched
off (Space, the arrow keys with and without modifiers, the speed keys, S, N, E). They
are launch options: nothing is saved, and the viewer's own VLC keeps its keys. The
buttons on VLC's bar and its menus still respond, but nothing a viewer does there
sticks: a pause or a speed change is undone within one exchange, and a seek, a Stop
or another file opened in the window as fast as the stream can be moved or opened
again (the table above; measured by doing each through VLC's control page).
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

Measure it the same way: `scripts/vlc-bench.mjs` puts the follower through TV events
(pause, skips, scrubbing, a mashed pause button, a speed change, the next episode),
a viewer's own actions and a dropped connection, under four networks, and prints how
long each takes to settle. The `live` profile runs the same against a real relay and real streams.

```sh
SSH=<windows host> node scripts/vlc-bench.mjs              # lan, cdn, slow, wan: 17 minutes
SSH=<windows host> node scripts/vlc-bench.mjs lan          # one profile
LIVE=https://watch.example WATCH_PASSWORD=... TV_KEY=... FIRST=<stream link> SECOND=<stream link> \
  SSH=<windows host> node scripts/vlc-bench.mjs live
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
