// Diagnostic jassub worker: mirrors the worker's console (libass logs included) and
// uncaught errors to the page over a BroadcastChannel, then loads the real worker.
// Selected with ?assdebug=1. Dynamic import so the console patch runs first.
const bc = new BroadcastChannel("jassub-log");
const fmt = a => a.map(x => (x && x.message) || (typeof x === "object" ? JSON.stringify(x).slice(0, 200) : String(x))).join(" ");
for (const k of ["debug", "log", "info", "warn", "error"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { try { bc.postMessage(`[${k}] ${fmt(a)}`); } catch {} orig(...a); };
}
self.addEventListener("error", e => { try { bc.postMessage(`[uncaught] ${e.message} @${e.filename}:${e.lineno}`); } catch {} });
self.addEventListener("unhandledrejection", e => { try { bc.postMessage(`[unhandledrejection] ${e.reason?.message || e.reason}`); } catch {} });
await import("jassub/dist/worker/worker.js");
