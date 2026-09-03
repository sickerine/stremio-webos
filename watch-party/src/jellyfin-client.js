const CLIENT_NAME = "Stremio TV Bridge";
const CLIENT_VERSION = "1.0.0";
const PLAY_ASSIGNMENT_RETRY_MS = 10_000;

function authorizationHeader(
  deviceId,
  token = "",
  clientName = CLIENT_NAME,
  deviceName = "LG webOS TV",
  clientVersion = CLIENT_VERSION,
) {
  const fields = [
    `Client="${clientName}"`,
    `Device="${deviceName}"`,
    `DeviceId="${deviceId}"`,
    `Version="${clientVersion}"`,
  ];
  if (token) fields.push(`Token="${token}"`);
  return `MediaBrowser ${fields.join(", ")}`;
}

export function createJellyfinClient(options = {}) {
  const baseUrl = (options.baseUrl || process.env.JELLYFIN_URL || "http://jellyfin:8096").replace(/\/$/, "");
  const username = options.username || process.env.JELLYFIN_USERNAME || "watchparty";
  const password = options.password || process.env.JELLYFIN_PASSWORD || "watchparty";
  const libraryName = options.libraryName || process.env.JELLYFIN_LIBRARY_NAME || "Watch Party";
  const deviceId = options.deviceId || process.env.JELLYFIN_DEVICE_ID || "stremio-tv-bridge";
  const fetchImplementation = options.fetchImplementation || fetch;
  const now = options.now || Date.now;
  let accessToken = "";
  let user = null;
  const browserAssignments = new Map();
  const subtitleTrackByItem = new Map();

  async function request(pathname, requestOptions = {}) {
    const headers = new Headers(requestOptions.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", authorizationHeader(deviceId, accessToken));
    if (requestOptions.body !== undefined) headers.set("content-type", "application/json");
    if (accessToken) headers.set("x-emby-token", accessToken);
    const response = await fetchImplementation(`${baseUrl}${pathname}`, { ...requestOptions, headers });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Jellyfin ${requestOptions.method || "GET"} ${pathname} failed (${response.status}): ${detail}`);
    }
    if (response.status === 204 || response.headers.get("content-length") === "0") return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function waitUntilReady() {
    let lastError;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { return await request("/System/Info/Public"); }
      catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw lastError;
  }

  async function completeStartupWizard() {
    await request("/Startup/User");
    await request("/Startup/Configuration", {
      method: "POST",
      body: JSON.stringify({ UICulture: "en-US", MetadataCountryCode: "US", PreferredMetadataLanguage: "en" }),
    });
    await request("/Startup/User", {
      method: "POST",
      body: JSON.stringify({ Name: username, Password: password }),
    });
    await request("/Startup/RemoteAccess", {
      method: "POST",
      body: JSON.stringify({ EnableRemoteAccess: true, EnableAutomaticPortMapping: false }),
    });
    await request("/Startup/Complete", { method: "POST" });
  }

  async function authenticate() {
    const result = await request("/Users/AuthenticateByName", {
      method: "POST",
      body: JSON.stringify({ Username: username, Pw: password }),
    });
    accessToken = result.AccessToken;
    user = result.User;
  }

  async function createViewerSession(viewerDeviceId) {
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/json",
      authorization: authorizationHeader(viewerDeviceId, "", "Jellyfin Web", "Browser", "10.11.11"),
    });
    const response = await fetchImplementation(`${baseUrl}/Users/AuthenticateByName`, {
      method: "POST",
      headers,
      body: JSON.stringify({ Username: username, Pw: password }),
    });
    if (!response.ok) throw new Error(`Jellyfin viewer authentication failed (${response.status})`);
    const result = await response.json();
    return {
      serverId: result.ServerId,
      userId: result.User.Id,
      accessToken: result.AccessToken,
      user: result.User,
    };
  }

  async function configureUser() {
    const configuration = {
      ...user.Configuration,
      SubtitleLanguagePreference: "eng",
      SubtitleMode: "Always",
      RememberSubtitleSelections: true,
    };
    await request(`/Users/Configuration?userId=${encodeURIComponent(user.Id)}`, {
      method: "POST",
      body: JSON.stringify(configuration),
    });
  }

  async function ensureLibrary() {
    const libraries = await request("/Library/VirtualFolders");
    if (libraries.some(library => library.Name === libraryName)) return;
    const query = new URLSearchParams({ name: libraryName, collectionType: "movies", paths: "/media", refreshLibrary: "true" });
    await request(`/Library/VirtualFolders?${query}`, {
      method: "POST",
      body: JSON.stringify({
        LibraryOptions: {
          EnableRealtimeMonitor: true,
          EnableInternetProviders: false,
          EnableChapterImageExtraction: false,
          ExtractChapterImagesDuringLibraryScan: false,
          MediaPathInfos: [{ Path: "/media" }],
        },
      }),
    });
  }

  async function initialize() {
    const info = await waitUntilReady();
    if (!info.StartupWizardCompleted) await completeStartupWizard();
    await authenticate();
    await configureUser();
    await ensureLibrary();
  }

  async function refreshLibrary() { await request("/Library/Refresh", { method: "POST" }); }

  async function findItemByPath(itemPath) {
    const query = new URLSearchParams({ Recursive: "true", Fields: "Path", Limit: "100" });
    const result = await request(`/Items?${query}`);
    return result.Items.find(item => item.Path === itemPath) || null;
  }

  async function controllableBrowserSessions() {
    const sessions = await request("/Sessions");
    return sessions.filter(session => session.Client === "Jellyfin Web" && session.SupportsRemoteControl);
  }

  async function subtitleTrackForItem(itemId) {
    if (!subtitleTrackByItem.has(itemId)) {
      subtitleTrackByItem.set(itemId, request(
        `/Users/${encodeURIComponent(user.Id)}/Items/${encodeURIComponent(itemId)}?Fields=MediaStreams,MediaSources`,
      ).then(item => {
        const mediaSource = item.MediaSources?.[0];
        const streams = item.MediaStreams || mediaSource?.MediaStreams || [];
        const subtitles = streams.filter(stream => stream.Type === "Subtitle" && Number.isInteger(stream.Index));
        const english = subtitles.find(stream => /^(eng|en)$/i.test(stream.Language || ""));
        const preferred = english || subtitles.find(stream => stream.IsDefault) || subtitles[0];
        if (!preferred) return null;
        return { index: preferred.Index, mediaSourceId: mediaSource?.Id || itemId };
      }).catch(() => null));
    }
    return subtitleTrackByItem.get(itemId);
  }

  async function playSession(sessionId, itemId, positionSeconds) {
    const query = new URLSearchParams({
      playCommand: "PlayNow",
      itemIds: itemId,
      startPositionTicks: String(Math.round(positionSeconds * 10_000_000)),
    });
    const subtitleTrack = await subtitleTrackForItem(itemId);
    if (Number.isInteger(subtitleTrack?.index)) query.set("subtitleStreamIndex", String(subtitleTrack.index));
    await request(`/Sessions/${encodeURIComponent(sessionId)}/Playing?${query}`, { method: "POST" });
  }

  async function commandSession(sessionId, command, positionSeconds) {
    const query = new URLSearchParams();
    if (command === "Seek") query.set("seekPositionTicks", String(Math.round(positionSeconds * 10_000_000)));
    const suffix = query.size ? `?${query}` : "";
    await request(`/Sessions/${encodeURIComponent(sessionId)}/Playing/${command}${suffix}`, { method: "POST" });
  }

  async function syncViewers(itemId, state, { actions = [], checkDrift = false } = {}) {
    const sessions = await controllableBrowserSessions();
    await Promise.all(sessions.map(async session => {
      if (session.NowPlayingItem?.Id !== itemId) {
        const assignment = browserAssignments.get(session.Id);
        if (assignment?.itemId === itemId
            && now() - assignment.lastActivityAtMs < PLAY_ASSIGNMENT_RETRY_MS) return;
        await playSession(session.Id, itemId, state.positionSeconds);
        browserAssignments.set(session.Id, { itemId, lastActivityAtMs: now() });
        if (state.paused) await commandSession(session.Id, "Pause", state.positionSeconds);
        return;
      }

      browserAssignments.set(session.Id, { itemId, lastActivityAtMs: now() });

      const browserPosition = Number(session.PlayState?.PositionTicks || 0) / 10_000_000;
      const shouldSeek = actions.includes("seek")
        || (checkDrift && session.PlayState?.CanSeek && Math.abs(browserPosition - state.positionSeconds) >= 4);
      if (shouldSeek) await commandSession(session.Id, "Seek", state.positionSeconds);

      if (actions.includes("pause")) await commandSession(session.Id, "Pause", state.positionSeconds);
      if (actions.includes("unpause")) await commandSession(session.Id, "Unpause", state.positionSeconds);
      if (checkDrift && !actions.includes("pause") && !actions.includes("unpause")
          && Boolean(session.PlayState?.IsPaused) !== state.paused) {
        await commandSession(session.Id, state.paused ? "Pause" : "Unpause", state.positionSeconds);
      }
    }));
    return sessions.length;
  }

  return {
    initialize,
    refreshLibrary,
    findItemByPath,
    syncViewers,
    createViewerSession,
    subtitleTrackForItem,
    status() { return { authenticated: Boolean(accessToken), userId: user?.Id || null }; },
  };
}
