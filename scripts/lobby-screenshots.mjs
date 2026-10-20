// Lobby TV v2 screenshots (1920x1080) on the demo seed: Friday Full Court (live 18:30 + next 19:30) and Saturday split
// (West + East live at 11:00 with that hour's cheer, next 12:00 with its cheer). Changes game states: reseed afterwards.
// Usage: [BASE_URL=http://localhost:3000] [ADMIN_PASSWORD=change-me-admin] [OUT_DIR=docs/screenshots/lobby-v2-built]
//        [CHROME_PATH=/usr/bin/google-chrome] node scripts/lobby-screenshots.mjs   (run on a fresh `seed-demo.js --reset`)
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import fs from 'node:fs';
const B = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''), WSB = B.replace(/^http/, 'ws');
const OUT = process.env.OUT_DIR || 'docs/screenshots/lobby-v2-built'; fs.mkdirSync(OUT, { recursive: true });
const t = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD || 'change-me-admin' }) })).json()).token;
const H = { authorization: 'Bearer ' + t, 'content-type': 'application/json' };
const api = async (p, o = {}) => (await fetch(B + p, { ...o, headers: { ...H, ...(o.headers || {}) } })).json();
const gs = await api('/api/games');
const local = (g) => new Date(g.scheduled_at).toLocaleString('sv-SE', { timeZone: 'America/Chicago' });
const days = [...new Set(gs.map((g) => local(g).slice(0, 10)))].sort(); const [fri, sat] = days;
const at = (d, time, court) => gs.find((g) => local(g).slice(0, 16) === `${d} ${time}` && g.court === court);
const done = [[at(fri, '17:30', 'Full'), 31, 27], ...['08:00', '09:00', '10:00'].flatMap((h, i) => [[at(sat, h, 'West'), 20 + i, 18], [at(sat, h, 'East'), 14, 16 + i]])];
await fetch(B + '/api/import/schedule.csv', { method: 'POST', headers: { ...H, 'content-type': 'text/csv' }, body: 'id,status,home_score,away_score\n' + done.map(([g, h, a]) => `${g.id},complete,${h},${a}`).join('\n') + '\n' });
async function live(g, court, pts) {
  await fetch(`${B}/api/games/${g.id}/start`, { method: 'POST', headers: H, body: '{"force":true}' });
  const ws = new WebSocket(`${WSB}/ws?court=${court}&role=score`, { headers: { authorization: 'Bearer ' + t } }); await new Promise((r) => ws.on('open', r));
  const send = (cmd) => new Promise((r) => { const id = Math.random().toString(36).slice(2); const h = (d) => { const m = JSON.parse(String(d)); if (m.id === id) { ws.off('message', h); r(m); } }; ws.on('message', h); ws.send(JSON.stringify({ type: 'cmd', id, cmd })); });
  for (const [team, p] of pts) await send({ type: 'SCORE', team, pts: p });
  await send({ type: 'PERIOD', delta: 1 }); await send({ type: 'CLOCK_START' });
  return ws;
}
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const shot = async (date, file) => {
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto(`${B}/upwardbasketballscores/lobby?date=${date}`); await p.waitForSelector('main .row'); await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/${file}` }); console.log('wrote', `${OUT}/${file}`); await p.close();
};
const wF = await live(at(fri, '18:30', 'Full'), 'full', [['home', 2], ['home', 2], ['away', 3], ['home', 2]]);
await shot(fri, 'friday-full.png');
await fetch(`${B}/api/games/${at(fri, '18:30', 'Full').id}/complete`, { method: 'POST', headers: H }); wF.close();
const wW = await live(at(sat, '11:00', 'West'), 'west', [['home', 2], ['away', 2], ['home', 3]]);
const wE = await live(at(sat, '11:00', 'East'), 'east', [['away', 2], ['home', 2], ['away', 2]]);
await shot(sat, 'saturday-split.png');
// Mixed day: West + East live at 15:00, next game on Full Court 16:30 (court label in the next band)
for (const g of [at(sat, '11:00', 'West'), at(sat, '11:00', 'East')]) await fetch(`${B}/api/games/${g.id}/complete`, { method: 'POST', headers: H });
wW.close(); wE.close();
await fetch(B + '/api/import/schedule.csv', { method: 'POST', headers: { ...H, 'content-type': 'text/csv' }, body: 'id,status,home_score,away_score\n' + ['12:00', '13:00', '14:00'].flatMap((h) => [at(sat, h, 'West'), at(sat, h, 'East')]).map((g) => `${g.id},complete,10,8`).join('\n') + '\n' });
const m1 = await live(at(sat, '15:00', 'West'), 'west', [['home', 2]]), m2 = await live(at(sat, '15:00', 'East'), 'east', [['away', 2]]);
await shot(sat, 'saturday-split-live-full-next.png');
m1.close(); m2.close(); await b.close();
