// Playwright e2e for Aaron's scorekeeping flow on a real phone-sized page:
// scan weekly QR (/score/east?t=...) -> signed in, token stripped from the URL -> pick a game -> confirm
// "Load ... on East Court?" -> score -> Complete game (confirm) -> picker again; the fixed TV link
// /upwardbasketballscores/eastcourt switches to the game and back to the idle "Next up" screen.
// Also: an expired/replaced QR shows a clear message and the PIN gate. Repeatable on a used database.
// Usage: CHROME_PATH=/usr/bin/google-chrome node scripts/flow-e2e.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
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
for (const x of (await api('/api/games')).filter((x) => x.status === 'active' && ['West', 'East', 'Full'].includes(x.court))) await api(`/api/games/${x.id}/complete`, { method: 'POST' });
const east = (await api('/api/courts')).find((c) => c.slug === 'east');
const t = async (n) => (await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: `${n}-${RUN}`, grade: '5th Grade' }) })).id;
const A = await t('Eagles'), B = await t('Lions');
const now = Math.floor(Date.now() / 60000) * 60000;
const g1 = (await api('/api/games', { method: 'POST', body: JSON.stringify({ court_id: east.id, home_team_id: A, away_team_id: B, scheduled_at: new Date(now).toISOString() }) })).id;
const g2 = (await api('/api/games', { method: 'POST', body: JSON.stringify({ court_id: east.id, home_team_id: B, away_team_id: A, scheduled_at: new Date(now + 60000).toISOString() }) })).id;
const qr = (await api('/api/qr')).find((q) => q.slug === 'east');

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const tv = await tvCtx.newPage();
await tv.goto(BASE + '/upwardbasketballscores/eastcourt');
await tv.waitForSelector('html.no-game', { timeout: 8000 }).catch(() => {});
ok(await tv.evaluate(() => document.documentElement.classList.contains('no-game') && document.documentElement.dataset.status === 'idle'), 'fixed TV link shows the idle screen while nothing is active');
ok(/Next up/.test(await tv.textContent('#idle')) && (await tv.textContent('[data-bind="next.matchup"]')).includes(`Eagles-${RUN} vs Lions-${RUN}`), `idle screen: Next up "${(await tv.textContent('#next-up')).replace(/\s+/g, ' ').trim()}"`);

console.log('1. scan the weekly QR');
const ph = await (await browser.newContext({ viewport: { width: 400, height: 860 } })).newPage();
await ph.goto(qr.url);
await ph.waitForSelector('#app:not([hidden])', { timeout: 8000 }).catch(() => {});
ok(await ph.$eval('#pin-gate', (e) => e.hidden) && !(await ph.evaluate(() => location.search)), 'QR scan: signed in with no PIN; token removed from the address bar');
ok(!!(await ph.evaluate(() => localStorage.getItem('sb-session-east'))), 'QR exchanged for the 12 h device session');

console.log('2. pick a game');
await ph.waitForSelector('#picker:not([hidden]) [data-game-id]', { timeout: 5000 }).catch(() => {});
const items = await ph.$$eval('#picker-list [data-game-id]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
ok(items.some((x) => x.includes(`5th Grade Eagles-${RUN} vs Lions-${RUN}`) && x.includes('Scheduled')), `picker lists today's games with grade + status badge (${items.length} games)`);
await ph.click(`[data-game-id="${g1}"]`);
await ph.waitForSelector('#confirm-dialog[open]', { timeout: 3000 }).catch(() => {});
const ct = await ph.textContent('#confirm-text');
ok(ct === `Load 5th Grade Eagles-${RUN} vs Lions-${RUN} on East Court?` && (await ph.textContent('#confirm-ok')) === 'Load', `confirm: "${ct}"`);
await ph.click('#confirm-ok');
await ph.waitForSelector('main.grid:not([hidden])', { timeout: 5000 }).catch(() => {});
ok(await ph.evaluate(() => document.documentElement.dataset.view === 'game'), 'Load: the controller shows the game');
await tv.waitForSelector('html:not(.no-game)', { timeout: 5000 }).catch(() => {});
ok((await tv.textContent('.home .name')).includes(`Eagles-${RUN}`) && (await tv.textContent('[data-bind="grade"]')) === '5th Grade', 'TV switched to the game automatically (with the grade)');
await ph.click('[data-cmd=\'{"type":"SCORE","team":"home","pts":2}\']');
await tv.waitForFunction(() => document.querySelector('.home .score').textContent === '2', null, { timeout: 4000 }).catch(() => {});
ok((await tv.textContent('.home .score')) === '2', 'tap +2 shows on the TV');

console.log('3. complete the game');
await ph.click('#complete-game');
await ph.waitForSelector('#confirm-dialog[open]', { timeout: 3000 }).catch(() => {});
ok(/Complete this game\? The final score .* 2 – 0 .* will be locked\./.test(await ph.textContent('#confirm-text')), `confirm: "${await ph.textContent('#confirm-text')}"`);
await ph.click('#confirm-ok');
await ph.waitForSelector('#picker:not([hidden])', { timeout: 5000 }).catch(() => {});
const after = await ph.$$eval('#picker-list [data-game-id]', (els) => els.map((e) => e.dataset.gameId));
ok(!after.includes(String(g1)) && after.includes(String(g2)), 'back to the picker; the completed game is gone from the list');
await tv.waitForSelector('html.no-game', { timeout: 5000 }).catch(() => {});
ok(/Final: 5th Grade · Eagles-\w+ 2 – 0 Lions/.test(await tv.textContent('[data-bind="lastFinal"]')), 'TV back to idle with the last final score');

console.log('4. resume on another device');
await api(`/api/games/${g2}/start`, { method: 'POST' });
const ph2 = await (await browser.newContext({ viewport: { width: 400, height: 860 } })).newPage();
await ph2.goto(qr.url);
await ph2.waitForSelector('#resume:not([hidden])', { timeout: 6000 }).catch(() => {});
ok(/is active on East Court/.test(await ph2.textContent('#resume-text')), `rejoining device is offered Resume ("${await ph2.textContent('#resume-text')}")`);
await ph2.click('#resume-ok');
ok(await ph2.evaluate(() => document.documentElement.dataset.view === 'game'), 'Resume opens the game');

console.log('5. replaced QR');
await api(`/api/courts/${east.id}/qr/regenerate`, { method: 'POST' });
const ph3 = await (await browser.newContext({ viewport: { width: 400, height: 860 } })).newPage();
await ph3.goto(qr.url);
await ph3.waitForFunction(() => /replaced by a newer one/.test(document.querySelector('#pin-err').textContent), null, { timeout: 6000 }).catch(() => {});
ok(await ph3.$eval('#pin-err', (e) => /replaced by a newer one/.test(e.textContent) && e.dataset.kind === 'wrong') && await ph3.$eval('#pin-gate', (e) => !e.hidden), 'old QR: clear message (data-kind="wrong") and the PIN gate as fallback');

await ph.waitForFunction(() => !document.querySelector('#pin-gate').hidden, null, { timeout: 6000 }).catch(() => {});
ok(await ph.$eval('#pin-err', (e) => /QR code that has been replaced/.test(e.textContent) && e.dataset.cause === 'revoked'), `phone signed in with the old QR is signed out on Regenerate ("${await ph.textContent('#pin-err')}")`);

console.log('6. QR lockout wording, idle TV cleanup, data-conn on new screens');
const ph4 = await (await browser.newContext({ viewport: { width: 400, height: 860 } })).newPage();
for (let i = 0; i < 5; i++) { await ph4.goto(`${BASE}/score/east?t=qr1.east.1.1.bad${i}`); await sleep(700); }
await ph4.waitForFunction(() => document.querySelector('#pin-err').dataset.kind === 'lockout', null, { timeout: 6000 }).catch(() => {});
ok(await ph4.$eval('#pin-err', (e) => /Too many invalid QR codes/.test(e.textContent) && e.dataset.kind === 'lockout' && e.dataset.cause === 'qr'), `QR lockout: "${await ph4.textContent('#pin-err')}"`);
await api(`/api/games/${g2}/complete`, { method: 'POST' });
await tv.waitForFunction(() => document.documentElement.dataset.status === 'idle', null, { timeout: 6000 }).catch(() => {});
const idle = await tv.evaluate(() => { const r = document.documentElement; return { cls: [...r.classList].filter((c) => /-(light|accent-fixed)$|^poss-|bonus/.test(c)), color: r.style.getPropertyValue('--home-color'), conn: document.getElementById('idle')?.dataset.conn }; });
ok(!idle.cls.length && !idle.color && idle.conn === 'online', `idle TV: no leftover side classes/colors, #idle has data-conn (${JSON.stringify(idle)})`);
ok(await ph.evaluate(() => document.getElementById('pin-gate').dataset.conn === 'online' && document.getElementById('picker').dataset.conn === 'online'), 'scorekeeper screens carry data-conn');

await browser.close();
await api(`/api/games/${g2}/complete`, { method: 'POST' });
console.log(`\nFlow e2e result: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
