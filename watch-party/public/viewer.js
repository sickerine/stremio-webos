const PLAYER_RESTRICTIONS = `
  .headerBackButton,
  .headerHomeButton,
  .btnPreviousTrack,
  .btnNextTrack,
  .btnPreviousChapter,
  .btnNextChapter,
  .btnRewind,
  .btnPause,
  .btnFastForward,
  .btnUserRating,
  .osdPositionSliderContainer { display: none !important; }
`;

export function createBrowserDeviceId(cryptoImplementation) {
  if (typeof cryptoImplementation.randomUUID === "function") {
    return `stremio-watch-${cryptoImplementation.randomUUID()}`;
  }

  const bytes = cryptoImplementation.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"));
  const uuid = `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  return `stremio-watch-${uuid}`;
}

export function createPassiveViewer(options = {}) {
  const document = options.document;
  const location = options.location;
  const storage = options.storage;
  const fetchImplementation = options.fetchImplementation;
  const WebSocketImplementation = options.WebSocketImplementation;
  const setIntervalImplementation = options.setIntervalImplementation;
  const clearIntervalImplementation = options.clearIntervalImplementation;
  const setTimeoutImplementation = options.setTimeoutImplementation;
  const clearTimeoutImplementation = options.clearTimeoutImplementation;
  const now = options.now || Date.now;
  const createDeviceId = options.createDeviceId;

  const waiting = document.getElementById("waiting");
  const player = document.getElementById("player");
  const statusTitle = document.getElementById("status-title");
  const statusBody = document.getElementById("status-body");
  const soundPrompt = document.getElementById("sound-prompt");
  let frame = null;
  let frameMonitor = null;
  let activeSessionId = null;
  let bootingSessionId = null;
  let tvPaused = true;
  let autoplayAttempt = null;
  let generation = 0;
  let socket = null;
  let reconnectTimer = null;
  let stopped = false;
  const viewerDeviceId = storage.getItem("stremio-watch-device-id") || createDeviceId();
  storage.setItem("stremio-watch-device-id", viewerDeviceId);

  function setStatus(title, body) {
    statusTitle.textContent = title;
    statusBody.textContent = body;
    waiting.hidden = false;
  }

  function clearFrame() {
    if (frameMonitor) clearIntervalImplementation(frameMonitor);
    frameMonitor = null;
    if (frame) frame.src = "about:blank";
    frame = null;
    autoplayAttempt = null;
    soundPrompt.hidden = true;
    player.replaceChildren();
    player.hidden = true;
  }

  function showWaiting(title = "Waiting for the TV", body = "Playback will appear here automatically.") {
    generation += 1;
    activeSessionId = null;
    bootingSessionId = null;
    clearFrame();
    setStatus(title, body);
  }

  function writeJellyfinSession(session) {
    if (!session?.serverId || !session?.userId || !session?.accessToken || !session?.user) {
      throw new Error("Incomplete viewer session");
    }
    const address = location.origin;
    storage.setItem("enableAutoLogin", "true");
    storage.setItem("_deviceId2", viewerDeviceId);
    storage.setItem(`user-${session.userId}-${session.serverId}`, JSON.stringify(session.user));
    storage.setItem("jellyfin_credentials", JSON.stringify({
      Servers: [{
        DateLastAccessed: now(),
        LastConnectionMode: 2,
        ManualAddress: address,
        manualAddressOnly: true,
        Name: "Stremio Watch",
        Id: session.serverId,
        LocalAddress: address,
        AccessToken: session.accessToken,
        UserId: session.userId,
      }],
    }));
  }

  function currentVideo() {
    try { return frame?.contentWindow?.document?.querySelector("video") || null; }
    catch (error) { return null; }
  }

  function enableSound() {
    const video = currentVideo();
    if (!video || !video.muted) return;
    video.muted = false;
    soundPrompt.hidden = true;
    if (!tvPaused) {
      Promise.resolve().then(() => video.play()).catch(() => {
        video.muted = true;
        soundPrompt.hidden = false;
      });
    }
  }

  function ensurePlaying(video) {
    if (tvPaused || !video.paused || autoplayAttempt) return;
    autoplayAttempt = Promise.resolve()
      .then(() => video.play())
      .catch(() => {
        video.muted = true;
        soundPrompt.hidden = false;
        return video.play();
      })
      .catch(() => {})
      .finally(() => { autoplayAttempt = null; });
  }

  function hardenPlayer(frameDocument) {
    if (!frameDocument || frameDocument.getElementById?.("passive-viewer-restrictions")) return;
    const style = frameDocument.createElement?.("style");
    if (style) {
      style.id = "passive-viewer-restrictions";
      style.textContent = PLAYER_RESTRICTIONS;
      frameDocument.head?.appendChild(style);
    }
    frameDocument.addEventListener?.("keydown", event => {
      enableSound();
      if ([" ", "k", "j", "l", "arrowleft", "arrowright", "pagedown", "pageup"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    frameDocument.addEventListener?.("pointerdown", enableSound, true);
  }

  function watchFrame(nextFrame) {
    frameMonitor = setIntervalImplementation(() => {
      if (nextFrame !== frame || !activeSessionId) return;
      try {
        const frameWindow = nextFrame.contentWindow;
        const frameDocument = frameWindow?.document;
        const video = frameDocument?.querySelector("video");
        hardenPlayer(frameDocument);
        if (!video || video.readyState < 2) {
          setStatus("Connecting to the TV", "Preparing the current stream and subtitles.");
          return;
        }
        ensurePlaying(video);
        waiting.hidden = true;
        player.hidden = false;
      } catch (error) {
        setStatus("Connecting to the TV", "Preparing the current stream and subtitles.");
      }
    }, 250);
  }

  async function showPlaying(message) {
    activeSessionId = message.sessionId;
    if (frame || bootingSessionId === message.sessionId) return;
    bootingSessionId = message.sessionId;
    const bootGeneration = ++generation;
    setStatus("Connecting to the TV", message.title || "Preparing the current stream and subtitles.");
    try {
      const response = await fetchImplementation("/api/viewer-session", {
        cache: "no-store",
        headers: { "x-viewer-device-id": viewerDeviceId },
      });
      if (!response.ok) throw new Error(`Viewer session failed (${response.status})`);
      const session = await response.json();
      if (bootGeneration !== generation || activeSessionId !== message.sessionId) return;
      writeJellyfinSession(session);
      const nextFrame = document.createElement("iframe");
      nextFrame.title = "TV playback";
      nextFrame.allow = "autoplay; fullscreen; picture-in-picture";
      nextFrame.allowFullscreen = true;
      nextFrame.src = "/web/#/home";
      frame = nextFrame;
      bootingSessionId = null;
      player.replaceChildren(nextFrame);
      player.hidden = false;
      watchFrame(nextFrame);
    } catch (error) {
      if (bootGeneration !== generation) return;
      bootingSessionId = null;
      setStatus("Unable to connect", "Retrying when the TV sends its next update.");
    }
  }

  function handleViewerState(message) {
    if (message?.type !== "viewer-state") return;
    if (message.mode === "playing" && message.sessionId) {
      tvPaused = Boolean(message.paused);
      showPlaying(message);
      return;
    }
    if (message.mode === "waiting") showWaiting();
  }

  function connect() {
    if (stopped) return;
    if (reconnectTimer) clearTimeoutImplementation(reconnectTimer);
    reconnectTimer = null;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocketImplementation(`${protocol}//${location.host}/ws?role=viewer`);
    socket.addEventListener("message", event => {
      try { handleViewerState(JSON.parse(event.data)); } catch (error) {}
    });
    socket.addEventListener("close", () => {
      socket = null;
      showWaiting("Reconnecting", "Trying to reach the TV bridge.");
      if (!stopped) reconnectTimer = setTimeoutImplementation(connect, 1_000);
    });
    socket.addEventListener("error", () => {
      try { socket.close(); } catch (error) {}
    });
  }


  soundPrompt.addEventListener("click", enableSound);
  document.addEventListener?.("pointerdown", enableSound, true);
  document.addEventListener?.("keydown", enableSound, true);

  showWaiting();
  connect();

  return {
    stop() {
      stopped = true;
      generation += 1;
      if (reconnectTimer) clearTimeoutImplementation(reconnectTimer);
      clearFrame();
      try { socket?.close(); } catch (error) {}
      socket = null;
    },
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  createPassiveViewer({
    document,
    location,
    storage: localStorage,
    fetchImplementation: fetch,
    WebSocketImplementation: WebSocket,
    setIntervalImplementation: setInterval,
    clearIntervalImplementation: clearInterval,
    setTimeoutImplementation: setTimeout,
    clearTimeoutImplementation: clearTimeout,
    createDeviceId: () => createBrowserDeviceId(crypto),
  });
}
