# Stremio Watch

Open one link and the page follows the LG TV. It waits when the TV is idle, starts the current stream automatically, follows play, pause, and seek changes, and returns to waiting when TV playback stops.

Jellyfin remains behind the page as the playback engine. It provides media probing, remuxing, transcoding, ASS/SSA subtitle rendering, embedded fonts, and browser playback. Viewers never need to see its library or login screen.

## Run

```sh
docker compose up --build -d
```

Open `http://localhost:3210/`. No login or playback selection is required. English subtitles are preferred automatically when the release contains them.

The Stremio TV bridge connects to:

```js
localStorage.setItem('watchPartyEnabled', '1');
localStorage.setItem('watchPartyUrl', 'ws://YOUR_COMPUTER_IP:3211/ws');
```

## Runtime behavior

- Browsers direct-play supported TorBox streams instead of always transcoding video.
- Unsupported formats use Jellyfin's normal remux/transcode decision tree.
- Jellyfin extracts embedded text subtitles and font attachments during the stream scan, so its libass player has them before playback begins.
- Viewers can choose subtitle and audio tracks, but playback controls cannot pause, skip, or seek away from the TV.
- The public page exposes only the current TV playback. Direct top-level Jellyfin pages redirect to the waiting page.
- A short disconnect grace period prevents TV WebSocket reconnects from flashing the viewer back to waiting.
- Docker limits Jellyfin to two CPU cores and 3 GiB of memory, and limits the bridge to half a core and 256 MiB.
