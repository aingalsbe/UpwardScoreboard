// Playwright e2e for QA #1: silent network drop (context.setOffline) on the TV and controller.
// Expects: status Offline within ~5 s, TV clock frozen (no countdown past a stop made while
// offline), recovery to Online with the exact server state after going back online.
// Usage: CHROME_PATH=/usr/bin/google-chrome node scripts/offline-e2e.mjs   (run BEFORE smoke.mjs)
import { pinBrowserClock, nextSaturday } from './_gameday.mjs'; // first: shared game-day helper + test clock
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
const PIN1 = process.env.PIN1 || '2222';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token; // waits out an admin-login lock left by a smoke run
for (let i = 0; i < 3 && !token; i++) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
  if (r.status === 429) { await sleep(Number(r.headers.get('retry-after') || 5) * 1000 + 300); continue; }
  token = (await r.json()).token;
}
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
// One active game per court: complete anything left active on the floor by earlier runs.
for (const x of (await (await fetch(BASE + '/api/games', { headers: H })).json()).filter((x) => x.status === 'active' && ['West', 'East', 'Full'].includes(x.court))) {
  await fetch(`${BASE}/api/games/${x.id}/complete`, { method: 'POST', headers: H });
}
const RUN = Date.now().toString(36).slice(-5);
const team = async (k) => (await (await fetch(BASE + '/api/teams', { method: 'POST', headers: H, body: JSON.stringify({ name: `Off${k}-${RUN}`, grade: '3rd Grade' }) })).json()).id;
const westId = (await (await fetch(BASE + '/api/courts', { headers: H })).json()).find((c) => c.slug === 'west').id;
const g = await (await fetch(BASE + '/api/games', { method: 'POST', headers: H, body: JSON.stringify({ court_id: westId, home_team_id: await team('A'), away_team_id: await team('B'), scheduled_at: new Date(Math.floor(Date.now() / 60000) * 60000).toISOString() }) })).json();
await fetch(`${BASE}/api/games/${g.id}/start`, { method: 'POST', headers: H });

// Node-side scorekeeper (unaffected by the browser going offline)
const sk = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?court=west&role=score`);
await new Promise((r) => sk.on('open', r));
sk.send(JSON.stringify({ type: 'auth', pin: PIN1 }));
const cmd = (c) => new Promise((res) => { const id = Math.random().toString(36).slice(2); const h = (d) => { const m = JSON.parse(String(d)); if (m.id === id) { sk.off('message', h); res(m); } }; sk.on('message', h); sk.send(JSON.stringify({ type: 'cmd', id, cmd: c })); });
await sleep(300);
await cmd({ type: 'CLOCK_STOP' });
await cmd({ type: 'CLOCK_SET', ms: 5 * 60_000 });
await cmd({ type: 'CLOCK_START' });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } }); await pinBrowserClock(ctx);
const tv = await ctx.newPage();
await tv.goto(BASE + '/tv/west');
await tv.waitForSelector('html[data-conn="online"]', { timeout: 10000 });
const ctl = await ctx.newPage();
await ctl.goto(BASE + '/score/west');
await ctl.fill('#pin', PIN1); await ctl.click('#pin-gate button');
await ctl.waitForSelector('#app:not([hidden])');
await ctl.click('#resume-ok'); // game was started from Admin, so this device is offered Resume
await ctl.waitForSelector('main.grid:not([hidden])');
const clock = (p) => p.textContent('[data-clock]');
await sleep(2500);
const before = await clock(tv);
ok(before < '05:00', `TV and controller online, clock running (${before})`);

console.log('A. go offline (setOffline)');
const t0 = Date.now();
await ctx.setOffline(true);
await tv.waitForSelector('html[data-conn="offline"]', { timeout: 5000 }).catch(() => {});
const tvOff = await tv.getAttribute('html', 'data-conn');
ok(tvOff === 'offline' && Date.now() - t0 <= 5000, `TV shows offline after ${Date.now() - t0} ms`);
await ctl.waitForFunction(() => /Offline/.test(document.querySelector('.pill.conn').textContent), null, { timeout: 5000 }).catch(() => {});
const pill = await ctl.textContent('.pill.conn');
ok(/Offline/.test(pill), `controller pill says "${pill.trim()}"`);
const tvPill = await ctl.evaluate(() => ({ t: document.querySelector('.pill.tv').textContent, stale: document.querySelector('.pill.tv').dataset.stale, cls: document.documentElement.classList.contains('presence-stale') }));
ok(!/TV connected/.test(tvPill.t) && tvPill.stale === 'true' && tvPill.cls, `TV pill is not left green while offline ("${tvPill.t.trim()}")`);
await cmd({ type: 'CLOCK_STOP' }); // the scorekeeper (still online elsewhere) stops the clock
const c1 = await clock(tv); await sleep(2500); const c2 = await clock(tv);
ok(c1 === c2, `TV clock frozen while offline (${c1} -> ${c2} after 2.5 s)`);
// Sage's offline style: dimmed (opacity) or marked (dashed border / muted color). Either counts.
const look = await tv.$eval('[data-clock]', (e) => { const c = getComputedStyle(e); return { opacity: c.opacity, border: c.borderStyle, color: c.color }; });
ok(Number(look.opacity) < 1 || /dashed/.test(look.border), `frozen clock is visibly marked offline (opacity ${look.opacity}, border ${look.border}, color ${look.color})`);

console.log('B. back online');
await cmd({ type: 'SCORE', team: 'home', pts: 3 }); // change made while TV was away
const st = await (await fetch(BASE + '/api/public/court/west')).json();
const t1 = Date.now();
await ctx.setOffline(false);
await tv.waitForSelector('html[data-conn="online"]', { timeout: 10000 }).catch(() => {});
ok((await tv.getAttribute('html', 'data-conn')) === 'online', `TV back online after ${Date.now() - t1} ms`);
await sleep(500);
const ms = st.game.state.clock.remainingMs;
const exp = `${String(Math.floor(Math.ceil(ms / 1000) / 60)).padStart(2, '0')}:${String(Math.ceil(ms / 1000) % 60).padStart(2, '0')}`;
const c3 = await clock(tv); await sleep(1500); const c4 = await clock(tv);
ok(c3 === exp && c4 === exp, `after resync TV shows the stopped server clock ${exp} (got ${c3}, ${c4})`);
const score = await tv.textContent('.home .score');
ok(Number(score) === st.game.state.home.score, `TV score resynced to ${score} (change made while offline)`);
await ctl.waitForFunction(() => /Online/.test(document.querySelector('.pill.conn').textContent), null, { timeout: 10000 }).catch(() => {});
ok(/Online/.test(await ctl.textContent('.pill.conn')), 'controller back online');

console.log('D. silent drop with no offline event (heartbeat watchdog)');
if (process.env.E2E_PAUSE_CMD) {
  const { execSync } = await import('node:child_process');
  await tv.waitForSelector('html[data-conn="online"]', { timeout: 10000 });
  const tp = Date.now();
  execSync(process.env.E2E_PAUSE_CMD); // e.g. freeze the server container: sockets go silent, no close, no offline event
  await tv.waitForSelector('html[data-conn="offline"]', { timeout: 6000 }).catch(() => {});
  const took = Date.now() - tp;
  const st2 = await tv.getAttribute('html', 'data-conn');
  const f1 = await clock(tv); await sleep(1500); const f2 = await clock(tv);
  execSync(process.env.E2E_UNPAUSE_CMD);
  ok(st2 !== 'online' && took <= 5000, `half-open socket detected by heartbeat in ${took} ms (status ${st2})`);
  ok(f1 === f2, `clock frozen during silent drop (${f1} -> ${f2})`);
  await tv.waitForSelector('html[data-conn="online"]', { timeout: 15000 }).catch(() => {});
  ok((await tv.getAttribute('html', 'data-conn')) === 'online', 'recovers after the server comes back');
} else console.log('  (skipped: set E2E_PAUSE_CMD/E2E_UNPAUSE_CMD, e.g. "docker pause <app container>")');

console.log('C. server drops the half-open peer (presence)');
await ctx.setOffline(true);
await sleep(7000); // server heartbeat: ping every 2 s, reap after 3.5 s of silence
const pres = await (async () => { const w = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?court=west&role=viewer`); return new Promise((r) => w.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'state') { w.close(); r(m.presence); } })); })();
ok(pres.displays === 0 && pres.controllers === 1, `server presence after drop: ${pres.displays} TV, ${pres.controllers} controller (browser sockets reaped)`);
await ctx.setOffline(false);

await browser.close(); sk.close();
await fetch(`${BASE}/api/games/${g.id}/complete`, { method: 'POST', headers: H }); // leave the court free
console.log(`\nOffline e2e result: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
