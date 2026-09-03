# Stremio Watch Party

Jellyfin provides the browser player, ASS/SSA subtitle rendering, media probing, and SyncPlay. The bridge imports the TV's selected HTTP stream as a `.strm` item and turns meaningful TV play, pause, and seek changes into SyncPlay commands.

## Run

```sh
docker compose up --build -d
```

Open `http://localhost:3210/web/` and sign in with `watchparty` / `watchparty`. Use Jellyfin's SyncPlay button to join the `home` group. The account automatically prefers English subtitles and always enables an available subtitle track.

The Stremio TV bridge connects to:

```js
localStorage.setItem('watchPartyEnabled', '1');
localStorage.setItem('watchPartyRoom', 'home');
localStorage.setItem('watchPartyUrl', 'ws://YOUR_COMPUTER_IP:3211/ws');
```

## Why Jellyfin

- Browsers direct-play supported TorBox streams instead of always transcoding video.
- Unsupported formats use Jellyfin's normal remux/transcode decision tree.
- Embedded ASS subtitles and fonts render through Jellyfin's libass player.
- SyncPlay handles browser coordination; the bridge does not fight browser buffering events.
- Docker limits Jellyfin to two CPU cores and 3 GiB of memory, and limits the bridge to half a core and 256 MiB.
