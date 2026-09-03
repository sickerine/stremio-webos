# Stremio Watch Party

The LG TV owns playback state. This service turns the TV's selected HTTP stream into browser-compatible HLS and keeps browser viewers aligned with the TV.

## Run it

```sh
docker compose up --build -d
```

Open `http://localhost:3210/?room=home`.

The TV bridge is inactive until these values exist in the Stremio app's local storage:

```js
localStorage.setItem('watchPartyEnabled', '1');
localStorage.setItem('watchPartyRoom', 'home');
localStorage.setItem('watchPartyUrl', 'ws://YOUR_COMPUTER_IP:3210/ws');
```

Reload the app after changing the values. The bridge uses the current video and clock exposed by `ass-controller.js`. It publishes source changes and playback state, but never accepts viewer control commands.

## Current scope

- Direct HTTP and debrid media URLs
- FFmpeg conversion to H.264/AAC HLS
- TV-led play, pause, seek, rate, buffering, and episode changes
- Viewer reconnect and drift correction
- One room per URL query, with `home` as the default

Torrent-only `infoHash` sources and remote Internet exposure are not part of this first local implementation.
