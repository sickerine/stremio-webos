import { estimateViewerPosition, synchronizationAction } from "/sync.js";

const video = document.querySelector("#player");
const connection = document.querySelector("#connection");
const overlay = document.querySelector("#overlay");
const overlayTitle = document.querySelector("#overlay-title");
const overlayBody = document.querySelector("#overlay-body");
const titleEl = document.querySelector("#title");
const joinButton = document.querySelector("#join");
const room = new URLSearchParams(location.search).get("room") || "home";

let hls = null;
let media = null;
let roomState = null;
let loadedUrl = null;
let playbackReady = false;
let audioUnlocked = false;

function setConnection(label, kind) {
  connection.className = `status ${kind}`;
  connection.textContent = label;
}

function setOverlay(visible, title, body) {
  overlay.hidden = !visible;
  if (title != null) overlayTitle.textContent = title;
  if (body != null) overlayBody.textContent = body;
}

function updateUi() {
  titleEl.textContent = roomState?.title || roomState?.episodeId || "";
  joinButton.hidden = audioUnlocked || !playbackReady;

  if (!roomState) { setOverlay(true, "Waiting for the TV", "Playback appears here automatically."); return; }
  if (!media || media.status === "preparing") { setOverlay(true, "Preparing the stream", "Remuxing to browser video."); return; }
  if (media.status === "error") { setOverlay(true, "Could not prepare the stream", media.error || "FFmpeg stopped early."); return; }
  if (!playbackReady) { setOverlay(true, "Loading video", "Catching up to the TV."); return; }
  setOverlay(false);
}

function destroyPlayer() {
  playbackReady = false;
  if (hls) hls.destroy();
  hls = null;
  video.removeAttribute("src");
  video.load();
}

function loadMedia(next) {
  media = next;
  updateUi();
  if (!media || media.status !== "ready" || media.playbackUrl === loadedUrl) return;

  destroyPlayer();
  loadedUrl = media.playbackUrl;

  if (window.Hls?.isSupported()) {
    // hls.js loads the subtitle rendition (the SUBTITLES group) itself and renders
    // its cues into a native TextTrack. subtitleDisplay=true keeps it showing.
    hls = new window.Hls({ backBufferLength: 90, maxBufferLength: 60, subtitleDisplay: true });
    hls.loadSource(media.playbackUrl);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => { playbackReady = true; updateUi(); });
    hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, () => { if (hls.subtitleTracks.length) hls.subtitleTrack = 0; });
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      media = { ...media, status: "error", error: data.details };
      updateUi();
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = media.playbackUrl; // Safari renders the HLS subtitle group itself.
    video.addEventListener("loadedmetadata", () => { playbackReady = true; updateUi(); }, { once: true });
  } else {
    media = { ...media, status: "error", error: "This browser cannot play HLS." };
    updateUi();
  }
}

function receiveState(next) {
  roomState = next ? { ...next, viewerReceivedAtMs: Date.now() } : null;
  updateUi();
}

function synchronize() {
  if (!playbackReady || !roomState || !media) return;
  const target = estimateViewerPosition(roomState, media);

  // position only: pause follows the TV pause, but NEVER its buffering.
  // Muted autoplay is allowed without a gesture, so we always start; the Tap-for-
  // sound button only unmutes.
  if (roomState.paused) { if (!video.paused) video.pause(); }
  else if (video.paused) { void video.play().catch(() => {}); }

  const action = synchronizationAction(video.currentTime || 0, target);
  if (action.type === "seek" && Number.isFinite(video.duration)) {
    video.currentTime = Math.min(action.positionSeconds, Math.max(0, video.duration - 0.05));
    video.playbackRate = 1;
  } else {
    video.playbackRate = action.playbackRate;
  }
}

joinButton.addEventListener("click", async () => {
  audioUnlocked = true;
  video.muted = false;
  joinButton.hidden = true;
  if (roomState && !roomState.paused) await video.play().catch(() => {});
  synchronize();
});

function connect() {
  setConnection("Connecting", "waiting");
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/ws?room=${encodeURIComponent(room)}&role=viewer`);
  socket.addEventListener("open", () => setConnection("Linked to TV", "connected"));
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.type === "hello") { loadMedia(message.media); receiveState(message.state); }
    else if (message.type === "room-state") receiveState(message.state);
    else if (message.type === "media-state") loadMedia(message.media);
  });
  socket.addEventListener("close", () => { setConnection("Reconnecting", "error"); setTimeout(connect, 1500); });
  socket.addEventListener("error", () => socket.close());
}

video.muted = true;
setInterval(synchronize, 250);
connect();
