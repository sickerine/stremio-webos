import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import { createCoordinator } from "./coordinator.js";
import { createJellyfinClient } from "./jellyfin-client.js";
import { createJellyfinProxy } from "./jellyfin-proxy.js";
import { createMediaLibrary } from "./media-library.js";

const PUBLIC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const PUBLIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/viewer.css", ["viewer.css", "text/css; charset=utf-8"]],
  ["/viewer.js", ["viewer.js", "text/javascript; charset=utf-8"]],
]);

export function normalizeState(candidate, nowMs = Date.now()) {
  if (!candidate || typeof candidate !== "object") return null;
  if (typeof candidate.sessionId !== "string" || !candidate.sessionId) return null;
  if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence < 0) return null;
  if (!Number.isFinite(candidate.positionSeconds) || candidate.positionSeconds < 0) return null;
  if (typeof candidate.mediaUrl !== "string" || !/^https?:\/\//i.test(candidate.mediaUrl)) return null;

  return {
    sessionId: candidate.sessionId,
    sequence: candidate.sequence,
    positionSeconds: candidate.positionSeconds,
    paused: Boolean(candidate.paused),
    playbackRate: Number.isFinite(candidate.playbackRate) && candidate.playbackRate > 0 ? candidate.playbackRate : 1,
    durationSeconds: Number.isFinite(candidate.durationSeconds) ? candidate.durationSeconds : null,
    mediaUrl: candidate.mediaUrl,
    title: typeof candidate.title === "string" ? candidate.title.slice(0, 300) : "",
    episodeId: typeof candidate.episodeId === "string" ? candidate.episodeId.slice(0, 100) : "",
    receivedAtMs: nowMs,
  };
}

export function createBridgeServer({
  coordinator,
  jellyfin,
  jellyfinProxy,
  now = Date.now,
  tvDisconnectGraceMs = 5_000,
} = {}) {
  let ready = Boolean(coordinator);
  let lastError = null;
  let activeCoordinator = coordinator;
  let viewerState = { type: "viewer-state", mode: "waiting" };
  const viewerSockets = new Set();
  const tvSockets = new Set();
  let tvDisconnectTimer = null;
  let closing = false;

  function broadcastViewerState() {
    const payload = JSON.stringify(viewerState);
    for (const viewer of viewerSockets) {
      if (viewer.readyState === WebSocket.OPEN) viewer.send(payload);
    }
  }

  function setWaiting() {
    if (viewerState.mode === "waiting") return;
    viewerState = { type: "viewer-state", mode: "waiting" };
    broadcastViewerState();
  }

  const httpServer = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://localhost");
    const publicFile = request.method === "GET" ? PUBLIC_FILES.get(requestUrl.pathname) : null;
    if (publicFile) {
      try {
        const body = await readFile(path.join(PUBLIC_ROOT, publicFile[0]));
        response.writeHead(200, {
          "content-type": publicFile[1],
          "cache-control": "no-store",
          "content-length": body.length,
        });
        response.end(body);
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end("Viewer unavailable");
      }
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/viewer-session") {
      const viewerDeviceId = request.headers["x-viewer-device-id"];
      if (typeof viewerDeviceId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(viewerDeviceId)) {
        response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "invalid-viewer-device" }));
        return;
      }
      try {
        const session = await jellyfin.createViewerSession(viewerDeviceId);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(session));
      } catch (error) {
        response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "viewer-session-failed" }));
      }
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: ready, service: "stremio-jellyfin-bridge", error: lastError?.message || null }));
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ready,
        error: lastError?.message || null,
        sync: activeCoordinator?.status() || null,
        viewer: viewerState,
      }));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname.startsWith("/web")
        && request.headers["sec-fetch-dest"] === "document") {
      response.writeHead(302, { location: "/", "cache-control": "no-store" });
      response.end();
      return;
    }
    if (jellyfinProxy) {
      jellyfinProxy.web(request, response);
      return;
    }
    response.writeHead(404);
    response.end("Not found");
  });

  const websocketServer = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    const role = url.searchParams.get("role");
    if (url.pathname !== "/ws") {
      if (jellyfinProxy) {
        jellyfinProxy.ws(request, socket, head);
        return;
      }
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    if (role !== "tv" && role !== "viewer") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, client => websocketServer.emit("connection", client, role));
  });

  websocketServer.on("connection", (socket, role) => {
    if (role === "viewer") {
      viewerSockets.add(socket);
      socket.send(JSON.stringify(viewerState));
      socket.once("close", () => viewerSockets.delete(socket));
      return;
    }

    tvSockets.add(socket);
    if (tvDisconnectTimer) clearTimeout(tvDisconnectTimer);
    tvDisconnectTimer = null;
    socket.once("close", () => {
      tvSockets.delete(socket);
      if (closing || tvSockets.size || tvDisconnectTimer) return;
      tvDisconnectTimer = setTimeout(() => {
        tvDisconnectTimer = null;
        if (!tvSockets.size) setWaiting();
      }, tvDisconnectGraceMs);
    });
    socket.send(JSON.stringify({ type: "hello", ready }));
    socket.on("message", async data => {
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { socket.send(JSON.stringify({ type: "error", code: "invalid-json" })); return; }
      if (message.type === "idle") {
        if (viewerState.mode !== "playing" || !message.sessionId || message.sessionId === viewerState.sessionId) {
          setWaiting();
        }
        socket.send(JSON.stringify({ type: "ack-idle", sessionId: message.sessionId || null }));
        return;
      }
      if (message.type !== "state") return;
      const state = normalizeState(message.state, now());
      if (!state) { socket.send(JSON.stringify({ type: "error", code: "invalid-state" })); return; }
      if (!ready) { socket.send(JSON.stringify({ type: "error", code: "not-ready" })); return; }
      try {
        const actions = await activeCoordinator.update(state);
        viewerState = {
          type: "viewer-state",
          mode: "playing",
          sessionId: state.sessionId,
          title: state.title,
          paused: state.paused,
          positionSeconds: state.positionSeconds,
        };
        broadcastViewerState();
        socket.send(JSON.stringify({ type: "ack", sequence: state.sequence, actions }));
      } catch (error) {
        lastError = error;
        socket.send(JSON.stringify({ type: "error", code: "sync-failed", detail: error.message }));
      }
    });
  });

  return {
    async initialize() {
      if (activeCoordinator) return;
      await jellyfin.initialize();
      activeCoordinator = createCoordinator({
        jellyfin,
        mediaLibrary: createMediaLibrary({ jellyfin }),
      });
      ready = true;
    },
    address() { return httpServer.address(); },
    listen(port, host) {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => { httpServer.off("error", reject); resolve(); });
      });
    },
    close() {
      closing = true;
      if (tvDisconnectTimer) clearTimeout(tvDisconnectTimer);
      tvDisconnectTimer = null;
      for (const client of websocketServer.clients) client.terminate();
      websocketServer.close();
      jellyfinProxy?.close();
      return new Promise((resolve, reject) => {
        httpServer.close(error => error ? reject(error) : resolve());
        httpServer.closeAllConnections?.();
      });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const jellyfinUrl = process.env.JELLYFIN_URL || "http://jellyfin:8096";
  const jellyfin = createJellyfinClient();
  const server = createBridgeServer({ jellyfin, jellyfinProxy: createJellyfinProxy({ target: jellyfinUrl }) });
  await server.listen(Number(process.env.PORT || 3211), "0.0.0.0");
  try {
    await server.initialize();
    console.log("Stremio Jellyfin bridge ready on port 3211");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    await server.close();
  }
}
