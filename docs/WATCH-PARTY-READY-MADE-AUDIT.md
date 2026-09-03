# Ready-made watch-party/player audit

Research snapshot: 2026-09-03. This is a read-only audit; no TV, app, runtime, or deployment was changed. Sources below are official upstream repositories or documentation.

## Bottom line

No candidate really satisfies the requested model of “the ready-made website/player does everything; our only custom code feeds it the TV URL and state” for the current Stremio workload.

The closest fit is **SyncTV**. It has a Docker server, synchronized rooms, a browser client, direct-URL/HLS/DASH sources, a typed source contract containing media plus subtitle URLs/headers/expiry, and a realtime protocol that accepts playback progress and play/pause/seek updates. Its official web repository also contains an ASS renderer based on `libass-wasm`. See [SyncTV's server overview](https://github.com/synctv-org/synctv/blob/v1.0.4/README.md), [playback/proxy contract](https://docs.syncs.tv/en/integrations/playback-and-proxy/), [direct-URL source schema](https://github.com/synctv-org/synctv/blob/v1.0.4/synctv-proto/proto/source_config.proto), and [official web ASS plugin](https://github.com/synctv-org/synctv-web/blob/4cdec2decfbd66b9ebd77bf8559cd0c696023583/src/plugins/artplayer-plugin-ass/index.js).

It still needs a small integration layer: create/update the room media item, preserve the original Stremio stream identity, make torrent/debrid/TV-local media reachable to the server, pass subtitle resources, and connect the TV as an authenticated controller that publishes state. That is materially smaller than writing another player, but it is not “only a TV-state hook.”

**Jellyfin** is the strongest media engine for FFmpeg fallback, embedded/external subtitles, and ASS/SSA handling, but it assumes library/media-source items. Making an arbitrary Stremio torrent or addon URL a Jellyfin item, then making a non-Jellyfin LG app the SyncPlay master, is a larger adapter than SyncTV. Jellyfin's own SyncPlay API is session/user-authenticated rather than a generic external-TV state endpoint. See [Jellyfin codec/subtitle support](https://jellyfin.org/docs/general/clients/codec-support/), [external subtitle naming](https://jellyfin.org/docs/general/server/media/shows/), [SyncPlay controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/SyncPlayController.cs), and [official container install](https://jellyfin.org/docs/general/installation/container/).

## Requirement matrix

| Candidate | Arbitrary direct/HLS Stremio source | Styled ASS/SSA + embedded/external subtitles | Rooms and sync | External TV-master/state seam | Docker and browser/media processing | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **SyncTV** | Direct URLs and HLS/DASH are first-class; URL must be reachable by the server or browser. Torrent IDs and TV loopback URLs still need a resolver/relay. | Server contract carries separate subtitle URLs, headers, format, and expiry. The official web source has an ASS/libass renderer, but the standalone web repo and the current server's embedded matching build should be version-verified together. | Yes; realtime WebSocket carries playback state, progress, and control messages. | Feasible as a native room client/bridge; no built-in “observe this Stremio TV” endpoint. | Official Docker Compose. Proxy/direct delivery and provider variants exist; generic `direct_url` is not a universal FFmpeg transcoder for every HEVC/MKV input. | **Closest overall.** |
| **Jellyfin SyncPlay** | No arbitrary addon/torrent ingestion. Media must become a Jellyfin library/media source or custom provider item. | Strongest option: web client advertises ASS/SSA external rendering, server supports extraction/burn-in/transcoding, and external `.ass` sidecars. | Yes; SyncPlay group creation/join/play/pause/seek/buffering/ready endpoints. | Requires an authenticated Jellyfin client/session and a custom Stremio-to-Jellyfin ingestion/master bridge. | Official Docker; mature FFmpeg media path and browser web client. | **Best media engine, not a TV-hook-only solution.** |
| **OpenTogetherTube** | HTTP MP4, HLS VOD, DASH VOD, or public custom manifests; custom sources must be HTTPS/browser-reachable and CORS-compatible. | Upstream custom manifest's text tracks are **WebVTT only**; no upstream styled ASS/SSA renderer. | Yes; rooms, roles, chat, and realtime sync. | No documented external TV-state API. | Docker Compose with Redis/PostgreSQL; browser playback but no arbitrary-source transcoder/relay. | Good room base, fails anime subtitle requirement without custom work. |
| **WatchParty** | README lists internet HTTP video, `.m3u8`, YouTube, and magnet/WebTorrent. | No official ASS/SSA or embedded-track pipeline found; no documented anime subtitle renderer/transcoder. | Yes; play/pause/seek sync, rooms/chat. | No documented TV-master/state API. | Docker/virtual-browser deployment; ordinary browser playback, no documented universal transcoder. | More complete than the current mini-player for rooms, not for this media/subtitle boundary. |
| **Sync-Player (Lakunake)** | Has a Direct URL UI, but recognizes only `.mp4/.webm/.m3u8/.ogg` and assigns the URL directly to `video.src`; no HLS.js/Shaka dependency. | README claims `.ass` via JASSUB/WSR and `.vtt`; implementation has a JASSUB path, but external playlist items are reset to empty track lists and the fallback ASS parser is intentionally basic. | Multi-room Socket.IO sync and admin remote play/pause/seek/playlist controls. | Socket.IO events exist, but no documented external TV-state API; the bridge would need admin authentication and event knowledge. | Docker Compose and local-file FFmpeg tools. FFmpeg paths operate on server `/media` files, not arbitrary Stremio URLs. | Tempting feature list, but needs HLS and external-track repairs before it is a ready-made answer. |

## Candidate details

### 1. SyncTV — closest fit, with explicit adapter boundaries

The server's official playback flow is already shaped like the requested integration: a provider returns one or more player-ready playback modes containing URLs, formats, headers, subtitles, and expiry; the client chooses direct, proxy, HLS, DASH, or a provider variant. The docs also explicitly support subtitle-specific headers and refreshing expiring URLs. [Playback and proxy documentation](https://docs.syncs.tv/en/integrations/playback-and-proxy/) and the [v1.0.4 protobuf contract](https://github.com/synctv-org/synctv/blob/v1.0.4/synctv-proto/proto/source_config.proto) are the source of truth.

The direct-URL schema accepts multiple media resources and multiple subtitle resources, each with URL, headers, format, and optional expiry. The client protocol exposes `AddMedia`, `StartPlayback`, `GetPlayback`, and `UpdatePlaybackState`; the room WebSocket carries `playback_progress` and `playback_update`. See [client API definitions](https://github.com/synctv-org/synctv/blob/v1.0.4/synctv-proto/proto/client.proto) and the [realtime protocol](https://docs.syncs.tv/en/integrations/realtime-api/).

The official `synctv-web` source contains an Artplayer player with HLS/DASH/MPEG-TS handling and routes ASS tracks through `libass-wasm`/SubtitlesOctopus. See [player source](https://github.com/synctv-org/synctv-web/blob/4cdec2decfbd66b9ebd77bf8559cd0c696023583/src/components/Player.vue), [subtitle selection](https://github.com/synctv-org/synctv-web/blob/4cdec2decfbd66b9ebd77bf8559cd0c696023583/src/plugins/subtitle.ts), and [sync plugin](https://github.com/synctv-org/synctv-web/blob/4cdec2decfbd66b9ebd77bf8559cd0c696023583/src/plugins/sync.ts). There is an important release check: the current app documentation says production Web builds are embedded in a matching server build ([official app README](https://github.com/synctv-org/synctv-app/blob/main/README.md)), so the exact ASS-capable web artifact must be verified against the selected server tag before adoption.

Unavoidable custom pieces for this project:

1. Capture the original Stremio stream object, not merely the TV's final loopback URL. A torrent `infoHash`/`fileIdx` needs to be resolved on a server or companion host; a TV-only `127.0.0.1` URL cannot be fetched by remote browsers.
2. Convert the selected stream into SyncTV's direct-URL source config, including the media format, signed headers, subtitle URLs, subtitle format (`ass`/`ssa`/`vtt` as actually supported by the verified client), and expirations.
3. Use a restricted authenticated room client on the TV side to publish source changes, play/pause, seeks, buffering, rate, and progress over SyncTV Realtime. This is the TV hook, but it is still an adapter.
4. If the selected stream is HEVC/MKV or otherwise unsupported by the browser, add a server-side browser rendition/transcoder. SyncTV's generic direct-URL source provides delivery/proxy and provider variants; it should not be assumed to be a universal FFmpeg transcoder.

SyncTV's official Docker Compose path runs the server, PostgreSQL, and Redis and exposes the HTTP API at port 8080. See [Docker installation](https://docs.syncs.tv/en/install/docker-compose/).

### 2. Jellyfin SyncPlay — excellent media plane, wrong ingestion boundary

Jellyfin's documented goal is Direct Play, with Direct Stream/remux or video transcoding when the browser cannot accept the container, codec, audio, or subtitles. Its codec table lists ASS/SSA as supported in MKV and explains that subtitle conversion can either remux or burn subtitles into video. The web client advertises external ASS/SSA subtitle profiles and the server can use fallback fonts for ASS rendering. See [codec support](https://jellyfin.org/docs/general/clients/codec-support/) and [configuration/fallback fonts](https://jellyfin.org/docs/general/administration/configuration/).

Its official web client includes SyncPlay group controls, while the server controller exposes authenticated create/join/list/group playback operations including queue, unpause, pause, stop, seek, buffering, and ready. See [Jellyfin Web SyncPlay source](https://github.com/jellyfin/jellyfin-web/tree/master/src/plugins/syncPlay) and [SyncPlayController.cs](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/SyncPlayController.cs).

The missing piece is source identity. Jellyfin's playback and SyncPlay APIs operate on Jellyfin media/session objects; they do not take an arbitrary Stremio addon stream or torrent `infoHash` and resolve it. A custom provider/plugin or temporary library item would be needed, and the LG Stremio app would still need to be represented by a Jellyfin-compatible controller client. That is a media-ingestion and client-integration project, not only a state hook.

### 3. OpenTogetherTube — good synchronization shell, VTT boundary

The official README advertises synchronized rooms and HTTP MP4, HLS VOD, DASH VOD, and custom media manifests. Its custom-media specification allows multiple source URLs and external text tracks, but limits source content types and says text tracks currently use `text/vtt`; URLs must be public HTTPS and CORS-enabled. See [README](https://github.com/dyc3/opentogethertube/blob/master/README.md) and [custom media format](https://github.com/dyc3/opentogethertube/blob/master/docs/custom-media-format.md).

The official deployment guide uses Docker Compose plus Redis/PostgreSQL and requires HTTPS/WebSocket proxying. See [deployment guide](https://github.com/dyc3/opentogethertube/blob/master/docs/how-to-deploy.md).

Therefore it needs the same Stremio media resolver/gateway as before, plus either ASS-to-VTT conversion (loses typesetting) or a custom/forked renderer. It does not reduce the work to a TV-state hook for styled anime.

### 4. WatchParty — broad input list, no verified anime subtitle path

The official README lists synchronized play/pause/seek, rooms/chat, internet HTTP video, `.m3u8` streams, and magnet links through WebTorrent. It also documents Docker-backed virtual browsers through neko. See [WatchParty README](https://github.com/howardchung/watchparty/blob/master/README.md).

I found no official ASS/SSA renderer, embedded subtitle extraction path, generic FFmpeg rendition path, or TV-master API in the upstream repository. Magnet support also does not automatically preserve Stremio's selected file, subtitle, headers, or debrid session semantics. It would still need a source/track adapter and likely a custom player change.

### 5. Sync-Player — closest feature checklist, but not ready for this media

Its README claims multi-room synchronization, Docker Compose, in-browser FFmpeg tools, and dynamic `.ass`/`.vtt` subtitle switching through JASSUB/WSR. See [official README](https://github.com/Lakunake/Sync-Player/blob/main/README.md) and [official Compose file](https://github.com/Lakunake/Sync-Player/blob/main/docker-compose.yaml).

The code audit finds four blockers:

- The Direct URL path does only `video.src = url`; the URL detector recognizes `.mp4`, `.webm`, `.m3u8`, and `.ogg`. There is no HLS.js/Shaka dependency, so `.m3u8` is not a reliable Chromium player input. See [URL detector](https://github.com/Lakunake/Sync-Player/blob/main/res/js/admin.js#L2127-L2132), [direct URL loader](https://github.com/Lakunake/Sync-Player/blob/main/res/js/client.js#L201-L215), and [package dependencies](https://github.com/Lakunake/Sync-Player/blob/main/res/package.json).
- On `set-playlist`, every external item is assigned `tracks: { audio: [], subtitles: [] }`; the caller's external track payload is discarded. See [playlist processing](https://github.com/Lakunake/Sync-Player/blob/main/res/server.js#L1512-L1525).
- The ASS path has real JASSUB wiring, but the runtime imports JASSUB `1.8.8` from a CDN while the package declares `2.4.1`, and it falls back to a deliberately basic DOM parser. See [JASSUB loader](https://github.com/Lakunake/Sync-Player/blob/main/res/js/client.js#L950-L1001) and [package.json](https://github.com/Lakunake/Sync-Player/blob/main/res/package.json).
- FFmpeg track/media helpers resolve files under the server's local `/media` directory. They are useful for uploaded files, not a transparent arbitrary Stremio URL/torrent/debrid source relay. No upstream test suite was present in the checked repository snapshot.

This candidate would require at least an HLS player fix, external-track preservation, a stable bundled subtitle renderer, server-reachable Stremio source resolution, and a documented/controller-safe TV bridge. That is not a configure-only integration.

## Why the current custom hls.js build did not satisfy the request

The project's existing `watch-party` service is a purpose-built media gateway plus a small hls.js viewer. Its [README](../watch-party/README.md) and [browser client](../watch-party/public/app.js) show that it owns the room state, HLS preparation, and player lifecycle. That solves a narrow “TV stream to browser” path, but it is not a complete ready-made media client:

- subtitle tracks—especially embedded/styled ASS—were not part of the ready-made player contract;
- media extraction, transcoding, signed URL/header handling, and subtitle fetching remained project-specific;
- the TV-to-room protocol and player behavior were custom code rather than a mature external room/client protocol;
- hls.js supplies HLS transport; it does not supply ASS rendering, torrent/debrid resolution, browser codec fallback, or a TV-master API.

The prior design note already records that an arbitrary Stremio torrent/loopback URL needs a server-side resolver and that OpenTogetherTube's upstream custom subtitle contract is VTT-only ([existing architecture note](./WATCH-PARTY-ARCHITECTURE.md)). The audit above adds SyncTV and Sync-Player, but does not change that fundamental boundary.

## Recommendation

Run a no-TV proof against **SyncTV v1.0.4** first:

1. Deploy the official Docker Compose stack and verify the matching embedded Web client, including one direct/HLS source and one external ASS track.
2. Add one Stremio adapter that preserves the source object, resolves one known stream on the companion host, creates a SyncTV direct-URL media item, and supplies subtitle URL/format/headers.
3. Add the TV bridge as a restricted SyncTV room client and test source change, play, pause, seek, buffering, resume, and expiry/reconnect.
4. If browser codec support requires universal FFmpeg conversion, use Jellyfin as the media plane instead—but accept that its ingestion and client bridge are larger.

Do not replace the current player based on a feature list alone. The go/no-go test is whether the exact SyncTV server/web build can play the selected Stremio source and styled ASS track through a server-reachable URL while the TV bridge publishes authoritative state.

