// Measure controller-tap -> TV-update latency over WebSocket (N samples).
import WebSocket from 'ws';
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/^http/, 'ws');
const N = Number(process.env.N || 100), PIN = process.env.PIN1 || '2222';
const open = (role) => new Promise((r) => { const w = new WebSocket(`${BASE}/ws?court=west&role=${role}`); w.on('open', () => r(w)); });
const tv = await open('tv'), sk = await open('score');
sk.send(JSON.stringify({ type: 'auth', pin: PIN }));
await new Promise((r) => setTimeout(r, 300));
let seen = new Map();
tv.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'state' && m.game) seen.set(m.game.state.seq, performance.now()); });
const acks = new Map();
sk.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'ack') acks.get(m.id)?.(m); });
const lat = [];
for (let i = 0; i < N; i++) {
  const id = 'lat' + i + Date.now(); const t0 = performance.now();
  const a = await new Promise((r) => { acks.set(id, r); sk.send(JSON.stringify({ type: 'cmd', id, cmd: { type: 'SCORE', team: 'away', pts: i % 2 ? -1 : 1 } })); });
  while (!seen.has(a.seq)) await new Promise((r) => setTimeout(r, 1));
  lat.push(seen.get(a.seq) - t0);
}
lat.sort((x, y) => x - y);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1);
console.log(`tap -> TV update over ${N} samples: median ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${lat[lat.length - 1].toFixed(1)} ms`);
tv.close(); sk.close();
