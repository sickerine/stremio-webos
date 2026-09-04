// WebSocket client for the relay. Emits: state(state), media(cdnUrl, sessionId), idle(), connection(status).
// Also keeps an NTP-style estimate of (local clock - relay clock) so relay timestamps
// on TV samples can be read in local time: toLocalMs(relayMs).
import { bestOffset } from "./sync.js";
const PING_BURST = 6, PING_BURST_GAP_MS = 250, PING_EVERY_MS = 10000, PING_KEEP = 8;

export function connectRelay({ room = "home", onState, onMedia, onIdle, onConnection, onResolveError }) {
  let socket = null, timer = null, closed = false;
  let pings = [], pingTimer = null, offset = null, rtt = null;
  const ping = () => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping", t: Date.now() })); };
  function startPings() {
    stopPings(); pings = [];
    let n = 0;
    const burst = () => { ping(); if (++n < PING_BURST) pingTimer = setTimeout(burst, PING_BURST_GAP_MS); else pingTimer = setInterval(ping, PING_EVERY_MS); };
    burst();
  }
  function stopPings() { clearTimeout(pingTimer); clearInterval(pingTimer); pingTimer = null; }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${location.host}/ws?room=${encodeURIComponent(room)}&role=viewer`;

  function open() {
    if (closed) return;
    onConnection?.("connecting");
    socket = new WebSocket(url);
    socket.addEventListener("open", () => { onConnection?.("connected"); startPings(); });
    socket.addEventListener("message", ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "pong") {
        const now = Date.now(), r = now - m.t;
        pings.push({ rtt: r, offset: (m.t + now) / 2 - m.serverMs }); if (pings.length > PING_KEEP) pings.shift();
        offset = bestOffset(pings); rtt = Math.min(...pings.map(p => p.rtt));
        return;
      }
      if (m.type === "hello") { if (m.state) { onState?.(m.state, m.resolveError, m.resolveHost); if (m.cdnUrl) onMedia?.(m.cdnUrl, m.state.sessionId, { size: m.size }); } else onIdle?.(); }
      else if (m.type === "room-state") { onState?.(m.state, m.resolveError, m.resolveHost); if (m.cdnUrl) onMedia?.(m.cdnUrl, m.state.sessionId, { size: m.size }); }
      else if (m.type === "room-media") { if (m.cdnUrl) onMedia?.(m.cdnUrl, m.sessionId, { size: m.size }); else onResolveError?.(m.resolveError, m.attempt, m.resolveHost); }
      else if (m.type === "room-idle") onIdle?.();
    });
    socket.addEventListener("close", () => { stopPings(); onConnection?.("reconnecting"); if (!closed) timer = setTimeout(open, 1500); });
    socket.addEventListener("error", () => { try { socket.close(); } catch {} });
  }
  open();
  return {
    close() { closed = true; clearTimeout(timer); stopPings(); try { socket?.close(); } catch {} },
    // relay timestamp -> local Date.now() ms; null until the first pong lands
    send(obj) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj)); },
    toLocalMs: relayMs => (offset == null || !Number.isFinite(relayMs) ? null : relayMs + offset),
    clock: () => ({ offsetMs: offset, rttMs: rtt }),
  };
}
