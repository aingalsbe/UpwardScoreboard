// Playwright e2e for Aaron's scorekeeping flow on a real phone-sized page:
// scan weekly QR (/score/east?t=...) -> signed in, token stripped from the URL -> pick a game -> confirm
// "Load ... on East Court?" -> score -> Complete game (confirm) -> picker again; the fixed TV link
// /upwardbasketballscores/eastcourt switches to the game and back to the idle "Next up" screen.
// Also: an expired/replaced QR shows a clear message and the PIN gate. Repeatable on a used database.
// Usage: CHROME_PATH=/usr/bin/google-chrome node scripts/flow-e2e.mjs
import { pinBrowserClock, nextSaturday } from './_gameday.mjs'; // first: shared game-day helper + test clock
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
// Safety (Avery R21f): this script completes, creates and DELETEs games. Before ANY request it refuses (exit 2) unless
// ALL hold: E2E_DESTRUCTIVE=1; the DATABASE_URL db name matches /(^|_)test(_|$)/i (not "contest"/"prod_attestation");
// BASE_URL host is localhost/127.0.0.1 AND its port equals E2E_PORT (default 18610), i.e. run-e2e.sh's throwaway server.
// E2E_GUARD_ONLY=1: evaluate the guard, print the verdict and exit (0 = accepted, 2 = refused) without any network I/O.
{
  const why = [];
  if (process.env.E2E_DESTRUCTIVE !== '1') why.push('E2E_DESTRUCTIVE=1 is not set');
  let dbName = ''; try { dbName = decodeURIComponent(new URL(process.env.DATABASE_URL || '').pathname.replace(/^\//, '')); } catch {}
  if (!/(^|_)test(_|$)/i.test(dbName)) why.push(`DATABASE_URL db "${dbName || '(unset)'}" is not a *_test_* database`);
  const want = String(process.env.E2E_PORT || '18610');
  let host = '', port = ''; try { const u = new URL(BASE); host = u.hostname; port = u.port || (u.protocol === 'https:' ? '443' : '80'); } catch {}
  if (!['localhost', '127.0.0.1'].includes(host) || port !== want) why.push(`BASE_URL ${BASE} is not localhost/127.0.0.1:${want} (E2E_PORT)`);
  if (why.length) { console.error(`flow-e2e: refusing to run (it deletes games): ${why.join('; ')}. Use scripts/run-e2e.sh flow-e2e.mjs.`); process.exit(2); }
  if (process.env.E2E_GUARD_ONLY === '1') { console.log(`flow-e2e guard: accepted (db ${dbName}, ${host}:${port})`); process.exit(0); }
}
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
const t = async (n) => (await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: `${n}-${RUN}`, grade: '5th-6th Grade' }) })).id;
const A = await t('Eagles'), B = await t('Lions');
const now = Math.floor(Date.now() / 60000) * 60000;
// Two games today on East in free slots (like colors-e2e §11): the server refuses East overlaps, the shared East/Full
// floor and anything outside 08:00-21:00 Fri/Sat, so try 30-min steps from now forward to the 21:00 cutoff, then back
// to 08:00, until it accepts (Sat 06:00 -> the morning; Fri 21:01 -> earlier today).
const at21 = new Date(now); at21.setHours(21, 0, 0, 0); const at08 = new Date(now); at08.setHours(8, 0, 0, 0);
const offsets = []; for (let m = 0; now + m * 60_000 <= at21.getTime(); m += 30) offsets.push(m); for (let m = -30; now + m * 60_000 >= at08.getTime(); m -= 30) offsets.push(m);
const today = new Date(now).toDateString(); let lastErr = '';
const hhmm = (t) => (Number.isFinite(t) ? new Date(t).toTimeString().slice(0, 5) : '--:--');
const create = async (home, away, at) => {
  const r = await fetch(BASE + '/api/games', { method: 'POST', headers: H, body: JSON.stringify({ court_id: east.id, home_team_id: home, away_team_id: away, scheduled_at: new Date(at).toISOString() }) });
  const j = await r.json().catch(() => ({})); if (r.ok && j.id) return j.id; lastErr = `slot ${hhmm(at)} rejected: ${r.status} ${j.error || ''}`.trim(); return null;
};
const mkGame = async (home, away, avoid) => {
  for (const m of offsets) {
    const at = now + m * 60_000; if (new Date(at).toDateString() !== today || avoid.some((x) => Math.abs(x - at) < 3_600_000)) continue;
    const id = await create(home, away, at); if (id) return { id, at };
  }
  return null;
};
// 1) find two free slots; 2) make the EARLIER one Eagles vs Lions (g1, loaded first) and the later Lions vs Eagles (g2).
let c1 = await mkGame(A, B, []), c2 = c1 && await mkGame(B, A, [c1.at]);
if (c1 && c2 && c2.at < c1.at) {
  const [early, late] = [c2.at, c1.at];
  for (const c of [c1, c2]) await fetch(`${BASE}/api/games/${c.id}`, { method: 'DELETE', headers: H });
  const e = await create(A, B, early), l = e && await create(B, A, late);
  c1 = e ? { id: e, at: early } : null; c2 = l ? { id: l, at: late } : null;
}
const g1 = c1?.id, g2 = c2?.id;
ok(!!g1 && !!g2, g1 && g2 ? `created Eagles vs Lions #${g1} @ ${hhmm(c1.at)} then Lions vs Eagles #${g2} @ ${hhmm(c2.at)} on East today`
  : `could not find two free East slots today (${new Date(now).toDateString()} ${hhmm(now)}; games only Fri/Sat 08:00-21:00): ${lastErr || 'no candidate slot'}`);
// The idle TV's "Next up" is the earliest unfinished East game today: drop seeded games that would come before g1
// (e.g. a stale 08:00 game on a faked Saturday evening) so Next up is ours. Test DB only (run-e2e seeds it fresh).
if (c1) for (const x of await api('/api/games')) if (x.court === 'East' && x.status === 'scheduled' && ![g1, g2].includes(x.id)
  && new Date(x.scheduled_at).toDateString() === today && Date.parse(x.scheduled_at) < c1.at) await fetch(`${BASE}/api/games/${x.id}`, { method: 'DELETE', headers: H });
// every expected string below comes from the created games' real home/away
const gm = Object.fromEntries((await api('/api/games')).filter((x) => [g1, g2].includes(x.id)).map((x) => [x.id, x]));
ok(!!g1 && (gm[g1]?.home_team_id === A && gm[g1]?.away_team_id === B), 'g1 (earlier) is Eagles home vs Lions away');
if (!g1 || !g2) { console.log(`Flow e2e result: ${pass} passed, ${fail} failed`); process.exit(1); }
const qr = (await api('/api/qr')).find((q) => q.slug === 'east');

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } }); await pinBrowserClock(tvCtx);
const tv = await tvCtx.newPage();
await tv.goto(BASE + '/upwardbasketballscores/eastcourt');
await tv.waitForSelector('html.no-game', { timeout: 8000 }).catch(() => {});
ok(await tv.evaluate(() => document.documentElement.classList.contains('no-game') && document.documentElement.dataset.status === 'idle'), 'fixed TV link shows the idle screen while nothing is active');
ok(/Next up/.test(await tv.textContent('#idle')) && (await tv.textContent('[data-bind="next.matchup"]')).includes(`Eagles-${RUN} vs Lions-${RUN}`), `idle screen: Next up "${(await tv.textContent('#next-up')).replace(/\s+/g, ' ').trim()}"`);

console.log('1. scan the weekly QR');
const ph = await (await browser.newContext({ viewport: { width: 400, height: 860 } }).then(async (c) => { await pinBrowserClock(c); return c; })).newPage();
await ph.goto(qr.url);
await ph.waitForSelector('#app:not([hidden])', { timeout: 8000 }).catch(() => {});
ok(await ph.$eval('#pin-gate', (e) => e.hidden) && !(await ph.evaluate(() => location.search)), 'QR scan: signed in with no PIN; token removed from the address bar');
ok(!!(await ph.evaluate(() => localStorage.getItem('sb-session-east'))), 'QR exchanged for the 12 h device session');

console.log('2. pick a game');
await ph.waitForSelector('#picker:not([hidden]) [data-game-id]', { timeout: 5000 }).catch(() => {});
const items = await ph.$$eval('#picker-list [data-game-id]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
ok(items.some((x) => x.includes(`5th-6th Grade Eagles-${RUN} vs Lions-${RUN}`) && x.includes('Scheduled')), `picker lists today's games with grade + status badge (${items.length} games)`);
await ph.click(`[data-game-id="${g1}"]`);
await ph.waitForSelector('#confirm-dialog[open]', { timeout: 3000 }).catch(() => {});
const ct = await ph.textContent('#confirm-text');
ok(ct === `Load 5th-6th Grade · Eagles-${RUN} vs Lions-${RUN} on East Court?` && (await ph.textContent('#confirm-ok')) === 'Load', `confirm: "${ct}"`);
await ph.click('#confirm-ok');
await ph.waitForSelector('main.grid:not([hidden])', { timeout: 5000 }).catch(() => {});
ok(await ph.evaluate(() => document.documentElement.dataset.view === 'game'), 'Load: the controller shows the game');
await tv.waitForSelector('html:not(.no-game)', { timeout: 5000 }).catch(() => {});
ok((await tv.textContent('.home .name')).includes(`Eagles-${RUN}`) && (await tv.textContent('[data-bind="grade"]')) === '5th-6th Grade', 'TV switched to the game automatically (with the grade)');
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
ok(/Final: 5th-6th Grade · Eagles-\w+ 2 – 0 Lions/.test(await tv.textContent('[data-bind="lastFinal"]')), 'TV back to idle with the last final score');

console.log('4. resume on another device');
await api(`/api/games/${g2}/start`, { method: 'POST' });
const ph2 = await (await browser.newContext({ viewport: { width: 400, height: 860 } }).then(async (c) => { await pinBrowserClock(c); return c; })).newPage();
await ph2.goto(qr.url);
await ph2.waitForSelector('#resume:not([hidden])', { timeout: 6000 }).catch(() => {});
ok(/is active on East Court/.test(await ph2.textContent('#resume-text')), `rejoining device is offered Resume ("${await ph2.textContent('#resume-text')}")`);
await ph2.click('#resume-ok');
ok(await ph2.evaluate(() => document.documentElement.dataset.view === 'game'), 'Resume opens the game');

console.log('5. replaced QR');
await api(`/api/courts/${east.id}/qr/regenerate`, { method: 'POST' });
const ph3 = await (await browser.newContext({ viewport: { width: 400, height: 860 } }).then(async (c) => { await pinBrowserClock(c); return c; })).newPage();
await ph3.goto(qr.url);
await ph3.waitForFunction(() => /replaced by a newer one/.test(document.querySelector('#pin-err').textContent), null, { timeout: 6000 }).catch(() => {});
ok(await ph3.$eval('#pin-err', (e) => /replaced by a newer one/.test(e.textContent) && e.dataset.cause === 'revoked') && await ph3.$eval('#pin-gate', (e) => !e.hidden), 'old QR: clear message (data-cause="revoked") and the PIN gate as fallback');

await ph.waitForFunction(() => !document.querySelector('#pin-gate').hidden, null, { timeout: 6000 }).catch(() => {});
ok(await ph.$eval('#pin-err', (e) => /QR code that has been replaced/.test(e.textContent) && e.dataset.cause === 'revoked'), `phone signed in with the old QR is signed out on Regenerate ("${await ph.textContent('#pin-err')}")`);

console.log('6. QR lockout wording, idle TV cleanup, data-conn on new screens');
const ph4 = await (await browser.newContext({ viewport: { width: 400, height: 860 } }).then(async (c) => { await pinBrowserClock(c); return c; })).newPage();
for (let i = 0; i < 5; i++) { await ph4.goto(`${BASE}/score/east?t=qr1.east.1.1.bad${i}`); await sleep(700); }
await ph4.waitForFunction(() => document.querySelector('#pin-err').dataset.kind === 'lockout', null, { timeout: 6000 }).catch(() => {});
ok(await ph4.$eval('#pin-err', (e) => /Too many invalid QR codes/.test(e.textContent) && e.dataset.kind === 'lockout' && e.dataset.cause === 'qr'), `QR lockout: "${await ph4.textContent('#pin-err')}"`);
await api(`/api/games/${g2}/complete`, { method: 'POST' });
await tv.waitForFunction(() => document.documentElement.dataset.status === 'idle', null, { timeout: 6000 }).catch(() => {});
const idle = await tv.evaluate(() => { const r = document.documentElement; return { cls: [...r.classList].filter((c) => /-(light|accent-fixed)$|^poss-|bonus/.test(c)), color: r.style.getPropertyValue('--home-color'), conn: document.getElementById('idle')?.dataset.conn }; });
ok(!idle.cls.filter((c) => !/-(light|accent-fixed)$/.test(c)).length && !idle.color && idle.conn === 'online', `idle TV: no leftover side classes/colors, #idle has data-conn (${JSON.stringify(idle)})`);
ok(await ph.evaluate(() => document.getElementById('pin-gate').dataset.conn === 'online' && document.getElementById('picker').dataset.conn === 'online'), 'scorekeeper screens carry data-conn');

await browser.close();
await api(`/api/games/${g2}/complete`, { method: 'POST' });
console.log(`\nFlow e2e result: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
