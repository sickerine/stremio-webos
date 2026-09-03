const PLAYER_RESTRICTIONS = `
  .skinHeader,
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
  .osdPositionSlider {
    pointer-events: none !important;
    touch-action: none !important;
  }
`;

const BLOCKED_PLAYBACK_KEYS = new Set([
  " ", "k", "j", "l", "arrowleft", "arrowright", "pagedown", "pageup",
  "home", "end", "navigationleft", "navigationright", "gamepaddpadleft",
  "gamepaddpadright", "gamepadleftthumbstickleft", "gamepadleftthumbstickright",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);

const SEEK_CONTROL_EVENTS = ["pointerdown", "mousedown", "touchstart", "click", "input", "change"];

export function isBlockedPlaybackKey(key) {
  return BLOCKED_PLAYBACK_KEYS.has(String(key || "").toLowerCase());
}

function isPositionSlider(target) {
  return Boolean(target?.matches?.(".osdPositionSlider") || target?.closest?.(".osdPositionSlider"));
}

function blockEvent(event) {
  event.preventDefault?.();
  event.stopImmediatePropagation?.();
}

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
  let frameBootstrap = null;
  let activeSessionId = null;
  let tvPaused = true;
  let tvPositionSeconds = null;
  let tvPositionReceivedAtMs = 0;
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

  function disposeFrame() {
    if (frameMonitor) clearIntervalImplementation(frameMonitor);
    frameMonitor = null;
    if (frame) frame.src = "about:blank";
    frame = null;
    frameBootstrap = null;
    autoplayAttempt = null;
    soundPrompt.hidden = true;
    player.replaceChildren();
    player.hidden = true;
  }

  function showWaiting(title = "Waiting for the TV", body = "Playback will appear here automatically.") {
    activeSessionId = null;
    tvPositionSeconds = null;
    autoplayAttempt = null;
    soundPrompt.hidden = true;
    player.hidden = true;
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

  function synchronizeVideo(video) {
    if (Number.isFinite(tvPositionSeconds)) {
      const elapsedSeconds = tvPaused ? 0 : Math.max(0, now() - tvPositionReceivedAtMs) / 1_000;
      const target = tvPositionSeconds + elapsedSeconds;
      if (Number.isFinite(video.duration)) {
        const boundedTarget = Math.min(target, Math.max(0, video.duration - 0.25));
        if (Math.abs(video.currentTime - boundedTarget) >= 1.5) video.currentTime = boundedTarget;
      }
    }
    if (tvPaused) {
      if (!video.paused) video.pause();
      return;
    }
    ensurePlaying(video);
  }

  function hardenPlayer(frameDocument) {
    if (!frameDocument) return;
    if (!frameDocument.getElementById?.("passive-viewer-restrictions")) {
      const style = frameDocument.createElement?.("style");
      if (style) {
        style.id = "passive-viewer-restrictions";
        style.textContent = PLAYER_RESTRICTIONS;
        frameDocument.head?.appendChild(style);
      }
      frameDocument.addEventListener?.("keydown", event => {
        enableSound();
        if (isPositionSlider(event.target) || isBlockedPlaybackKey(event.key)) blockEvent(event);
      }, true);
      for (const eventName of SEEK_CONTROL_EVENTS) {
        frameDocument.addEventListener?.(eventName, event => {
          if (!isPositionSlider(event.target)) return;
          enableSound();
          blockEvent(event);
        }, true);
      }
      frameDocument.addEventListener?.("pointerdown", enableSound, true);
    }

    for (const slider of frameDocument.querySelectorAll?.(".osdPositionSlider") || []) {
      slider.tabIndex = -1;
      slider.setAttribute?.("aria-disabled", "true");
      slider.classList?.remove?.("focusable");
    }
  }

  function watchFrame(nextFrame) {
    frameMonitor = setIntervalImplementation(() => {
      if (nextFrame !== frame) return;
      try {
        const frameWindow = nextFrame.contentWindow;
        const frameDocument = frameWindow?.document;
        const video = frameDocument?.querySelector("video");
        hardenPlayer(frameDocument);
        if (!activeSessionId) return;
        if (!video || video.readyState < 2) {
          setStatus("Connecting to the TV", "Preparing the current stream.");
          return;
        }
        if (frameWindow.location?.hash !== "#/video") frameWindow.location.hash = "#/video";
        synchronizeVideo(video);
        waiting.hidden = true;
        player.hidden = false;
      } catch (error) {
        setStatus("Connecting to the TV", "Preparing the current stream.");
      }
    }, 250);
  }

  function prepareFrame() {
    if (frame) return Promise.resolve(frame);
    if (frameBootstrap) return frameBootstrap;
    const bootGeneration = ++generation;
    frameBootstrap = (async () => {
      const response = await fetchImplementation("/api/viewer-session", {
        cache: "no-store",
        headers: { "x-viewer-device-id": viewerDeviceId },
      });
      if (!response.ok) throw new Error(`Viewer session failed (${response.status})`);
      const session = await response.json();
      if (bootGeneration !== generation || stopped) return null;
      writeJellyfinSession(session);
      const nextFrame = document.createElement("iframe");
      nextFrame.title = "TV playback";
      nextFrame.allow = "autoplay; fullscreen; picture-in-picture";
      nextFrame.allowFullscreen = true;
      nextFrame.src = "/web/#/video";
      frame = nextFrame;
      player.replaceChildren(nextFrame);
      player.hidden = !activeSessionId;
      watchFrame(nextFrame);
      return nextFrame;
    })().finally(() => {
      frameBootstrap = null;
    });
    return frameBootstrap;
  }

  async function showPlaying(message) {
    const sessionChanged = activeSessionId !== message.sessionId;
    activeSessionId = message.sessionId;
    if (sessionChanged || !frame) {
      setStatus("Connecting to the TV", message.title || "Preparing the current stream.");
    }
    try {
      await prepareFrame();
      if (activeSessionId === message.sessionId && frame) player.hidden = false;
    } catch (error) {
      if (activeSessionId === message.sessionId) {
        setStatus("Unable to connect", "Retrying when the TV sends its next update.");
      }
    }
  }

  function handleViewerState(message) {
    if (message?.type !== "viewer-state") return;
    if (message.mode === "playing" && message.sessionId) {
      tvPaused = Boolean(message.paused);
      if (Number.isFinite(message.positionSeconds)) {
        tvPositionSeconds = message.positionSeconds;
        tvPositionReceivedAtMs = now();
      }
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
  prepareFrame().catch(() => {});
  connect();

  return {
    stop() {
      stopped = true;
      generation += 1;
      if (reconnectTimer) clearTimeoutImplementation(reconnectTimer);
      disposeFrame();
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
