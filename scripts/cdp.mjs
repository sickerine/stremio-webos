#!/usr/bin/env node
// Minimal CDP client for the webOS app.
//
//   ssh -N -L 9998:127.0.0.1:9998 -i ~/.ssh/tv_key -p 9922 prisoner@192.168.1.9 &
//   node scripts/cdp.mjs targets
//   node scripts/cdp.mjs eval 'document.title'
//   node scripts/cdp.mjs screenshot out.png     # UI only: webOS draws video on a hardware plane, so it comes out blank
//
// Node >= 22 (global WebSocket, no deps).
// CDP_HOST=192.168.1.37 talks to the TV's inspector directly instead of the tunnel.
//
// Read-only by nature: it just evaluates an expression in the page and prints the
// JSON result. Used to observe live player/subtitle state without a rebuild.
import http from 'http';
import { writeFileSync } from 'fs';

const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = process.env.CDP_PORT || 9998;

function get(path) {
  return new Promise((res, rej) => {
    http.get({ host: HOST, port: PORT, path }, r => {
      let b = '';
      r.on('data', c => (b += c));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error('bad json: ' + b.slice(0, 200))); } });
    }).on('error', rej);
  });
}

async function pickTarget() {
  const list = await get('/json');
  const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('no inspectable page (is the app running?)');
  // Prefer the Stremio page over about:blank / splash
  return pages.find(p => /stremio|8080|index/i.test(p.url)) || pages[0];
}

async function call(method, params) {
  const t = await pickTarget();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const result = await new Promise((resolve, reject) => {
    const id = 1;
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 15000);
    ws.onmessage = m => {
      const msg = JSON.parse(m.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      resolve(msg.result);
    };
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.close();
  return result;
}

async function evaluate(expr) {
  const r = (await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
  return r?.value !== undefined ? r.value : r;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'targets') {
    const l = await get('/json');
    console.log(l.map(t => `${t.type}\t${t.title}\t${t.url}`).join('\n'));
  } else if (cmd === 'eval') {
    const out = await evaluate(rest.join(' '));
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  } else if (cmd === 'screenshot') {
    const out = rest[0] || 'tv.png';
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(data, 'base64'));
    console.log(out);
  } else {
    console.log('usage: cdp.mjs targets | eval <expr> | screenshot [out.png]');
    process.exit(2);
  }
} catch (e) {
  console.error('ERR: ' + e.message);
  process.exit(1);
}
