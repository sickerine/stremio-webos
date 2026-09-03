# Stremio Watch Party

Jellyfin provides the browser player, ASS/SSA subtitle rendering, media probing, and remote-session controls. The bridge imports the TV's selected HTTP stream as a `.strm` item and sends meaningful TV play, pause, and seek changes directly to every open Jellyfin browser session.

## Run

```sh
docker compose up --build -d
```

Open `http://localhost:3210/web/` and sign in with `watchparty` / `watchparty`. Playback starts automatically when the TV starts a stream. The account automatically prefers English subtitles and always enables an available subtitle track.

The Stremio TV bridge connects to:

```js
localStorage.setItem('watchPartyEnabled', '1');
localStorage.setItem('watchPartyUrl', 'ws://YOUR_COMPUTER_IP:3211/ws');
```

## Why Jellyfin

- Browsers direct-play supported TorBox streams instead of always transcoding video.
- Unsupported formats use Jellyfin's normal remux/transcode decision tree.
- Embedded ASS subtitles and fonts render through Jellyfin's libass player.
- Jellyfin's remote-session API controls each browser without a fake SyncPlay client or buffer-wait state machine.
- Docker limits Jellyfin to two CPU cores and 3 GiB of memory, and limits the bridge to half a core and 256 MiB.
