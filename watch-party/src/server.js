import http from "node:http";
import { WebSocketServer } from "ws";

import { createCoordinator } from "./coordinator.js";
import { createJellyfinClient } from "./jellyfin-client.js";
import { createMediaLibrary } from "./media-library.js";

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

export function createBridgeServer({ coordinator, jellyfin, now = Date.now } = {}) {
  let ready = Boolean(coordinator);
  let lastError = null;
  let activeCoordinator = coordinator;

  const httpServer = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: ready, service: "stremio-jellyfin-bridge", error: lastError?.message || null }));
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ready, error: lastError?.message || null, sync: activeCoordinator?.status() || null }));
      return;
    }
    response.writeHead(404);
    response.end("Not found");
  });

  const websocketServer = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/ws" || url.searchParams.get("role") !== "tv") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, client => websocketServer.emit("connection", client));
  });

  websocketServer.on("connection", socket => {
    socket.send(JSON.stringify({ type: "hello", ready }));
    socket.on("message", async data => {
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { socket.send(JSON.stringify({ type: "error", code: "invalid-json" })); return; }
      if (message.type !== "state") return;
      const state = normalizeState(message.state, now());
      if (!state) { socket.send(JSON.stringify({ type: "error", code: "invalid-state" })); return; }
      if (!ready) { socket.send(JSON.stringify({ type: "error", code: "not-ready" })); return; }
      try {
        const actions = await activeCoordinator.update(state);
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
        groupName: process.env.WATCH_PARTY_ROOM || "home",
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
      for (const client of websocketServer.clients) client.terminate();
      websocketServer.close();
      return new Promise((resolve, reject) => {
        httpServer.close(error => error ? reject(error) : resolve());
        httpServer.closeAllConnections?.();
      });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const jellyfin = createJellyfinClient();
  const server = createBridgeServer({ jellyfin });
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
