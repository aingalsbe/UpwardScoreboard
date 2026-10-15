// Playwright e2e for QA round 2 item A/D: wrong PINs on court-2 must not lock out court-1.
// court-1 controller signs in -> court-2 controller (another phone) enters 5 wrong PINs and sees a
// countdown -> court-1 loses its connection, taps +2 while offline, comes back -> the queued tap is
// sent with no PIN prompt and the server score goes up by exactly 2. Repeatable on a used database.
// Usage: CHROME_PATH=/usr/bin/google-chrome node scripts/lockout-e2e.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
const PIN1 = process.env.PIN1 || '1111';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36).slice(-5);

let token;
for (let i = 0; i < 3 && !token; i++) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
  if (r.status === 429) { await sleep(Number(r.headers.get('retry-after') || 5) * 1000 + 300); continue; }
  token = (await r.json()).token;
}
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = async (p, o = {}) => (await fetch(BASE + p, { ...o, headers: H })).json();
const courts = await api('/api/courts');
const team = async (k) => (await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: `E2E${k}-${RUN}`, short_name: `E${k}`, primary_color: '#0d2c6b', secondary_color: '#f2b705' }) })).id;
for (const [slug, a, b] of [['court-1', 'A', 'B'], ['court-2', 'C', 'D']]) {
  const c = courts.find((x) => x.slug === slug);
  const day = new Date(); day.setUTCHours(15, 0, 0, 0);
  const g = await api('/api/games', { method: 'POST', body: JSON.stringify({ court_id: c.id, home_team_id: await team(a), away_team_id: await team(b), scheduled_at: new Date(day.getTime() + (1 + Math.floor(Math.random() * 900)) * 86_400_000).toISOString(), division: `E2E ${RUN}` }) });
  await api(`/api/games/${g.id}/start`, { method: 'POST' });
}
const score = async () => (await (await fetch(BASE + '/api/public/court/court-1')).json()).game.state.home.score;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctxA = await browser.newContext({ viewport: { width: 420, height: 860 } }); // court-1 phone
const ctxB = await browser.newContext({ viewport: { width: 420, height: 860 } }); // court-2 phone
const p1 = await ctxA.newPage(); const p2 = await ctxB.newPage();

console.log('1. court-1 signs in');
await p1.goto(BASE + '/score/court-1');
await p1.fill('#pin', PIN1); await p1.click('#pin-gate button');
await p1.waitForSelector('#app:not([hidden])', { timeout: 5000 });
const sess = await p1.evaluate(() => localStorage.getItem('sb-session-court-1'));
ok(!!sess, 'court-1 unlocked; court session token stored in localStorage');

console.log('2. court-2 enters 5 wrong PINs');
await p2.goto(BASE + '/score/court-2');
for (let i = 0; i < 5; i++) {
  await p2.waitForFunction(() => !document.querySelector('#pin-gate button').disabled && document.querySelector('html').dataset.conn === 'online', null, { timeout: 8000 }).catch(() => {});
  await p2.fill('#pin', String(9100 + i)); await p2.click('#pin-gate button');
  await p2.waitForFunction((n) => /Wrong PIN|Too many/.test(document.querySelector('#pin-err').textContent), i, { timeout: 5000 }).catch(() => {});
  await sleep(250);
}
await p2.waitForFunction(() => /Too many wrong PINs\. Try again in \d+ s/.test(document.querySelector('#pin-err').textContent), null, { timeout: 5000 }).catch(() => {});
const m1 = await p2.textContent('#pin-err'); await sleep(2100); const m2 = await p2.textContent('#pin-err');
const n1 = Number(m1.match(/(\d+) s/)?.[1]), n2 = Number(m2.match(/(\d+) s/)?.[1]);
ok(n1 > 0 && n2 < n1, `court-2 shows a ticking lockout countdown ("${m1.trim()}" -> "${m2.trim()}")`);
ok(await p2.$eval('#pin-gate button', (b) => b.disabled), 'Unlock button disabled during the lockout');

console.log('3. court-1 blips, taps +2 while offline, reconnects');
const before = await score();
await ctxA.setOffline(true);
await p1.waitForFunction(() => /Offline/.test(document.querySelector('.pill.conn').textContent), null, { timeout: 6000 }).catch(() => {});
await p1.click('[data-cmd=\'{"type":"SCORE","team":"home","pts":2}\']');
await sleep(300);
const pend = await p1.textContent('#pending');
ok(/1 tap sending/.test(pend), `tap queued while offline ("${pend.trim()}")`);
await ctxA.setOffline(false);
await p1.waitForFunction(() => document.querySelector('#pending').hidden, null, { timeout: 15000 }).catch(() => {});
ok(await p1.$eval('#pending', (e) => e.hidden), 'queued tap delivered after reconnect');
ok(await p1.$eval('#pin-gate', (e) => e.hidden), 'court-1 never asked for the PIN again (session token)');
const after = await score();
ok(after === before + 2, `server score +2 exactly once (${before} -> ${after})`);

console.log('4. reload court-1: still signed in');
await p1.reload(); await p1.waitForSelector('#app:not([hidden])', { timeout: 6000 }).catch(() => {});
ok(await p1.$eval('#pin-gate', (e) => e.hidden), 'reload reuses the session (no PIN prompt)');

await browser.close();
console.log(`\nLockout e2e result: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
