import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import { createMediaManager } from "./media-manager.js";

export function createWatchPartyServer(options = {}) {
  const rooms = new Map();
  const mediaRoot = options.mediaRoot || process.env.MEDIA_ROOT || "/data/media";
  const publicRoot = options.publicRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  const mediaManager = options.mediaManager || createMediaManager({ mediaRoot });

  function serveFile(response, filePath, contentType, cacheControl = "no-store") {
    void stat(filePath).then(file => {
      if (!file.isFile()) throw new Error("Not a file");
      response.writeHead(200, {
        "cache-control": cacheControl,
        "content-length": file.size,
        "content-type": contentType,
      });
      createReadStream(filePath).pipe(response);
    }).catch(() => {
      response.writeHead(404);
      response.end("Not found");
    });
  }

  function roomFor(roomId) {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        clients: new Set(),
        media: null,
        mediaSessionId: null,
        state: null,
      });
    }
    return rooms.get(roomId);
  }

  function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function broadcast(room, message) {
    for (const client of room.clients) send(client, message);
  }

  function normalizeState(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    if (typeof candidate.sessionId !== "string" || !candidate.sessionId) return null;
    if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence < 0) return null;
    if (!Number.isFinite(candidate.positionSeconds) || candidate.positionSeconds < 0) return null;

    const mediaUrl = typeof candidate.mediaUrl === "string" && /^https?:\/\//i.test(candidate.mediaUrl)
      ? candidate.mediaUrl
      : null;

    return {
      sessionId: candidate.sessionId,
      sequence: candidate.sequence,
      positionSeconds: candidate.positionSeconds,
      paused: Boolean(candidate.paused),
      playbackRate: Number.isFinite(candidate.playbackRate) && candidate.playbackRate > 0
        ? candidate.playbackRate
        : 1,
      buffering: Boolean(candidate.buffering),
      durationSeconds: Number.isFinite(candidate.durationSeconds)
        ? candidate.durationSeconds
        : null,
      mediaUrl,
      title: typeof candidate.title === "string" ? candidate.title.slice(0, 300) : "",
      episodeId: typeof candidate.episodeId === "string" ? candidate.episodeId.slice(0, 100) : "",
      receivedAtMs: Date.now(),
    };
  }

  const httpServer = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "stremio-watch-party" }));
      return;
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      serveFile(response, path.join(publicRoot, "index.html"), "text/html; charset=utf-8");
      return;
    }

    const publicAssets = {
      "/app.js": ["app.js", "text/javascript; charset=utf-8"],
      "/styles.css": ["styles.css", "text/css; charset=utf-8"],
      "/sync.js": ["sync.js", "text/javascript; charset=utf-8"],
    };
    if (request.method === "GET" && publicAssets[url.pathname]) {
      const [filename, contentType] = publicAssets[url.pathname];
      serveFile(response, path.join(publicRoot, filename), contentType);
      return;
    }

    if (request.method === "GET" && url.pathname === "/vendor/hls.min.js") {
      serveFile(
        response,
        path.resolve(publicRoot, "../node_modules/hls.js/dist/hls.min.js"),
        "text/javascript; charset=utf-8",
        "public, max-age=31536000, immutable",
      );
      return;
    }

    const roomMatch = /^\/api\/rooms\/([a-z0-9_-]{1,64})$/i.exec(url.pathname);
    if (request.method === "GET" && roomMatch) {
      const room = roomFor(roomMatch[1]);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      response.end(JSON.stringify({
        room: roomMatch[1],
        state: room.state,
        media: room.media,
      }));
      return;
    }

    const mediaMatch = /^\/media\/([a-f0-9]{24})\/(master\.m3u8|segment-\d{6}\.ts)$/.exec(url.pathname);
    if (request.method === "GET" && mediaMatch) {
      const filePath = path.join(mediaRoot, mediaMatch[1], mediaMatch[2]);
      void stat(filePath).then(file => {
        if (!file.isFile()) throw new Error("Not a file");
        response.writeHead(200, {
          "cache-control": mediaMatch[2].endsWith(".m3u8") ? "no-store" : "public, max-age=31536000, immutable",
          "content-length": file.size,
          "content-type": mediaMatch[2].endsWith(".m3u8")
            ? "application/vnd.apple.mpegurl"
            : "video/mp2t",
        });
        createReadStream(filePath).pipe(response);
      }).catch(() => {
        response.writeHead(404);
        response.end("Not found");
      });
      return;
    }

    response.writeHead(404);
    response.end("Not found");
  });

  const websocketServer = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    const roomId = url.searchParams.get("room") || "home";
    const role = url.searchParams.get("role");
    if (url.pathname !== "/ws" || !/^[a-z0-9_-]{1,64}$/i.test(roomId) || !["tv", "viewer"].includes(role)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, client => {
      websocketServer.emit("connection", client, { roomId, role });
    });
  });

  websocketServer.on("connection", (socket, identity) => {
    const room = roomFor(identity.roomId);
    socket.watchPartyRole = identity.role;
    room.clients.add(socket);
    send(socket, {
      type: "hello",
      role: identity.role,
      room: identity.roomId,
      state: room.state,
      media: room.media,
    });

    socket.on("message", data => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        send(socket, { type: "error", code: "invalid-json" });
        return;
      }

      if (message.type !== "state") return;
      if (identity.role !== "tv") {
        send(socket, { type: "error", code: "viewer-read-only" });
        return;
      }

      const nextState = normalizeState(message.state);
      if (!nextState) {
        send(socket, { type: "error", code: "invalid-state" });
        return;
      }

      const previous = room.state;
      if (previous && previous.sessionId === nextState.sessionId && previous.sequence >= nextState.sequence) {
        return;
      }

      room.state = nextState;
      broadcast(room, { type: "room-state", state: nextState });

      if (nextState.mediaUrl && room.mediaSessionId !== nextState.sessionId) {
        if (room.mediaSessionId) mediaManager.release?.(room.mediaSessionId);
        room.mediaSessionId = nextState.sessionId;
        mediaManager.prepare(nextState, media => {
          if (room.mediaSessionId !== nextState.sessionId) return;
          room.media = media;
          broadcast(room, { type: "media-state", media });
        });
      }
    });

    socket.on("close", () => room.clients.delete(socket));
  });

  return {
    address() {
      return httpServer.address();
    },
    listen(port, host) {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
    },
    close() {
      const closeHttp = new Promise((resolve, reject) => {
        for (const client of websocketServer.clients) client.terminate();
        websocketServer.close();
        httpServer.close(error => error ? reject(error) : resolve());
        httpServer.closeAllConnections?.();
      });
      return Promise.all([closeHttp, Promise.resolve(mediaManager.close())]);
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createWatchPartyServer();
  const port = Number(process.env.PORT || 3210);
  await server.listen(port, "0.0.0.0");
  console.log(`Stremio Watch Party listening on http://0.0.0.0:${port}`);
}
