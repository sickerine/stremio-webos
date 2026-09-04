// WebSocket client for the relay. Emits: state(state), media(cdnUrl, sessionId), idle(), connection(status).
export function connectRelay({ room = "home", onState, onMedia, onIdle, onConnection }) {
  let socket = null, timer = null, closed = false;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${location.host}/ws?room=${encodeURIComponent(room)}&role=viewer`;

  function open() {
    if (closed) return;
    onConnection?.("connecting");
    socket = new WebSocket(url);
    socket.addEventListener("open", () => onConnection?.("connected"));
    socket.addEventListener("message", ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "hello") { if (m.state) { onState?.(m.state); if (m.cdnUrl) onMedia?.(m.cdnUrl, m.state.sessionId, { size: m.size }); } else onIdle?.(); }
      else if (m.type === "room-state") { onState?.(m.state); if (m.cdnUrl) onMedia?.(m.cdnUrl, m.state.sessionId, { size: m.size }); }
      else if (m.type === "room-media") onMedia?.(m.cdnUrl, m.sessionId, { size: m.size, resolveError: m.resolveError });
      else if (m.type === "room-idle") onIdle?.();
    });
    socket.addEventListener("close", () => { onConnection?.("reconnecting"); if (!closed) timer = setTimeout(open, 1500); });
    socket.addEventListener("error", () => { try { socket.close(); } catch {} });
  }
  open();
  return { close() { closed = true; clearTimeout(timer); try { socket?.close(); } catch {} } };
}
