import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectRelay } from '../web/src/relay.js';

test('first browser open waits for the full calibration and discards the slow first estimate', { timeout: 3000 }, async t => {
  let socket, connection, delivered = 0, replies = 0;
  const timers = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); socket = this; }
    send(json) {
      const msg = JSON.parse(json); if (msg.type !== 'ping') return;
      const first = replies === 0;
      timers.push(setTimeout(() => {
        replies++;
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'pong', t: msg.t, serverMs: Date.now() + (first ? 400 : 1000) }) }));
        if (replies < 6) { assert.equal(delivered, 0); assert.equal(connection.toLocalMs(0), null); }
      }, first ? 25 : 0));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const saved = ['WebSocket', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:', host: 'fixture' } });
  t.after(() => { connection?.close(); timers.forEach(clearTimeout); for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  await new Promise(resolve => {
    connection = connectRelay({ onState: () => { delivered++; resolve(); } });
    socket.dispatchEvent(new Event('open'));
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'hello', state: { sessionId: 's', sequence: 1 } }) }));
  });
  assert.equal(replies, 6);
  assert.equal(connection.clock().ready, true);
  assert.ok(Math.abs(connection.clock().offsetMs + 1000) < 20);
  assert.equal(delivered, 1);
});
