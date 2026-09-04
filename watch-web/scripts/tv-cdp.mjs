// Evaluate JS in the TV app page over the SSH-tunnelled webOS inspector (local :9997 -> TV :9998).
// Usage: ssh -N -L 9997:127.0.0.1:9998 -i ~/.ssh/tv_key -p 9922 prisoner@TV_IP &   then   node scripts/tv-cdp.mjs "<expr>"
import http from "node:http"; import { WebSocket } from "ws";
const expr = process.argv[2];
const targets = await new Promise((res, rej) => http.get("http://127.0.0.1:9997/json", r => { let b=""; r.on("data", c=>b+=c); r.on("end", ()=>res(JSON.parse(b))); }).on("error", rej));
const t = targets.find(x => x.type === "page") || targets[0];
const ws = new WebSocket(t.webSocketDebuggerUrl.replace(/192\.168\.1\.\d+:9998/, "127.0.0.1:9997"), { perMessageDeflate: false });
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
ws.on("message", d => { const m = JSON.parse(d); if (m.id === 1) { console.log(JSON.stringify(m.result?.result?.value ?? m.result ?? m.error)); ws.close(); process.exit(0); } });
setTimeout(() => { console.log("timeout"); process.exit(1); }, 10000);
