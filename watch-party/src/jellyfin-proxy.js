import { createProxyServer } from "httpxy";

export function createJellyfinProxy({ target }) {
  const proxy = createProxyServer({
    target: target.replace(/\/$/, ""),
    ws: true,
    xfwd: true,
  });

  return {
    async web(request, response) {
      try {
        await proxy.web(request, response);
      } catch (error) {
        if (response.headersSent) {
          response.destroy(error);
          return;
        }
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        response.end("Playback engine unavailable");
      }
    },
    ws(request, socket, head) {
      proxy.ws(request, socket, {}, head).catch(() => socket.destroy());
    },
    close() { proxy.close?.(); },
  };
}
