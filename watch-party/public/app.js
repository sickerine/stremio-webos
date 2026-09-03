import { estimateViewerPosition, synchronizationAction } from "/sync.js";

const video = document.querySelector("#player");
const connection = document.querySelector("#connection");
const emptyState = document.querySelector("#empty-state");
const buffering = document.querySelector("#buffering");
const title = document.querySelector("#title");
const detail = document.querySelector("#detail");
const joinButton = document.querySelector("#join");
const room = new URLSearchParams(location.search).get("room") || "home";

let hls = null;
let media = null;
let roomState = null;
let loadedPlaybackUrl = null;
let playbackReady = false;
let audioUnlocked = false;

detail.textContent = `Room: ${room}`;

function setConnection(label, kind) {
  connection.className = `status ${kind}`;
  connection.innerHTML = `<span></span>${label}`;
}

function updateLabels() {
  title.textContent = roomState?.title || roomState?.episodeId || "Nothing yet";
  buffering.hidden = !roomState?.buffering;
  emptyState.hidden = Boolean(media && media.status !== "error");
  joinButton.disabled = !playbackReady;

  if (media?.status === "preparing") {
    emptyState.hidden = false;
    emptyState.querySelector("h2").textContent = "Preparing the stream";
    emptyState.querySelector("p:last-child").textContent = "Converting it into browser-compatible video.";
  } else if (media?.status === "error") {
    emptyState.hidden = false;
    emptyState.querySelector("h2").textContent = "The stream could not be prepared";
    emptyState.querySelector("p:last-child").textContent = media.error || "FFmpeg stopped before video was ready.";
  }
}

function destroyPlayer() {
  playbackReady = false;
  if (hls) hls.destroy();
  hls = null;
  video.removeAttribute("src");
  video.load();
}

function loadMedia(nextMedia) {
  media = nextMedia;
  updateLabels();
  if (!media || media.status !== "ready" || media.playbackUrl === loadedPlaybackUrl) return;

  destroyPlayer();
  loadedPlaybackUrl = media.playbackUrl;

  if (window.Hls?.isSupported()) {
    hls = new window.Hls({
      backBufferLength: 90,
      maxBufferLength: 60,
    });
    hls.loadSource(media.playbackUrl);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      playbackReady = true;
      updateLabels();
    });
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      media = { ...media, status: "error", error: data.details };
      updateLabels();
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = media.playbackUrl;
    video.addEventListener("loadedmetadata", () => {
      playbackReady = true;
      updateLabels();
    }, { once: true });
  } else {
    media = { ...media, status: "error", error: "This browser cannot play HLS video." };
    updateLabels();
  }
}

function receiveState(nextState) {
  roomState = nextState ? { ...nextState, viewerReceivedAtMs: Date.now() } : null;
  updateLabels();
}

function synchronize() {
  if (!playbackReady || !roomState || !media) return;
  const target = estimateViewerPosition(roomState, media);
  const shouldPause = roomState.paused || roomState.buffering;

  if (shouldPause) {
    if (!video.paused) video.pause();
  } else if (audioUnlocked && video.paused) {
    void video.play().catch(() => {});
  }

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
  joinButton.textContent = "Following TV";
  if (roomState && !roomState.paused && !roomState.buffering) {
    await video.play().catch(() => {});
  }
  synchronize();
});

function connect() {
  setConnection("Connecting", "waiting");
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/ws?room=${encodeURIComponent(room)}&role=viewer`);

  socket.addEventListener("open", () => setConnection("TV link ready", "connected"));
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.type === "hello") {
      loadMedia(message.media);
      receiveState(message.state);
    } else if (message.type === "room-state") {
      receiveState(message.state);
    } else if (message.type === "media-state") {
      loadMedia(message.media);
    }
  });
  socket.addEventListener("close", () => {
    setConnection("Reconnecting", "error");
    setTimeout(connect, 1500);
  });
  socket.addEventListener("error", () => socket.close());
}

setInterval(synchronize, 250);
connect();
