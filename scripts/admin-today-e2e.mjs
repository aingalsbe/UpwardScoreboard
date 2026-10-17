// Browser e2e for bug A1 (Admin Today list): a completed game shows FINAL with its score, the active game shows LIVE
// and updates live over the WebSocket (score, complete, reopen) without a reload; at 390px nothing scrolls sideways.
// Creates two games today on East (05:00 final, 06:00 live) with its own teams, and removes them afterwards.
// Screenshots: OUT_DIR (default docs/screenshots/admin)/admin-today-{390,1440}.png
// Usage: [BASE_URL=http://localhost:3000] [CHROME_PATH=/usr/bin/google-chrome] node scripts/admin-today-e2e.mjs
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import fs from 'node:fs';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin', PIN_EAST = process.env.PIN_EAST || '3333';
const OUT = process.env.OUT_DIR || 'docs/screenshots/admin';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token;
for (let i = 0; i < 10 && !token; i++) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
  if (r.status === 429) { await sleep(Number(r.headers.get('retry-after') || 5) * 1000 + 300); continue; }
  token = (await r.json()).token;
}
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = async (p, o = {}) => (await fetch(BASE + p, { ...o, headers: { ...H, ...(o.headers || {}) } })).json();
const csv = (body) => api('/api/import/schedule.csv', { method: 'POST', body, headers: { 'content-type': 'text/csv' } });
const tz = (await api('/api/me')).tz;
const today = new Date().toLocaleDateString('sv-SE', { timeZone: tz });
for (const g of (await api('/api/games')).filter((g) => g.status === 'active' && ['West', 'East', 'Full'].includes(g.court))) await api(`/api/games/${g.id}/complete`, { method: 'POST' });
const RUN = Date.now().toString(36).slice(-5);
const mk = async (n) => (await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: `${n}-${RUN}`, short_name: n.slice(0, 3), grade: '3rd Grade', gender: 'Boys' }) })).id;
const tA = await mk('Admn'), tB = await mk('Bdmn');
const imp = await csv(`date,time,court,grade,gender,home,away\n${today},05:00,east,3rd Grade,Boys,Admn-${RUN},Bdmn-${RUN}\n${today},06:00,east,3rd Grade,Boys,Bdmn-${RUN},Admn-${RUN}\n`);
const mine = (await api('/api/games')).filter((g) => [tA, tB].includes(g.home_team_id));
const fin = mine.find((g) => g.home_team_id === tA), act = mine.find((g) => g.home_team_id === tB);
ok(imp.created === 2 && fin && act, `two games today (${today}) on East`);
await csv(`id,status,home_score,away_score\n${fin.id},complete,21,17\n`);
await api(`/api/games/${act.id}/start`, { method: 'POST', body: '{"force":true}' });
const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?court=east&role=score`); await new Promise((r) => ws.on('open', r));
const send = (o) => new Promise((r) => { const id = Math.random().toString(36).slice(2); const h = (d) => { const m = JSON.parse(String(d)); if (m.type === 'auth' || (m.type === 'ack' && m.id === id)) { ws.off('message', h); r(m); } }; ws.on('message', h); ws.send(JSON.stringify({ ...o, id })); });
await send({ type: 'auth', pin: PIN_EAST, device: 'admin-today-e2e' });
await send({ type: 'cmd', cmd: { type: 'SCORE', team: 'home', pts: 2 } });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
page.on('pageerror', (e) => ok(false, `page error: ${e.message}`));
fs.mkdirSync(OUT, { recursive: true });
await page.goto(`${BASE}/admin#today`);
if (await page.isVisible('#login')) { await page.fill('#password', ADMIN); await page.press('#password', 'Enter'); }
const row = (id) => page.evaluate((id) => { const r = document.querySelector(`#today-games tr[data-game-id="${id}"]`); return r && { result: r.dataset.result, status: r.dataset.status, winner: r.dataset.winner || '', score: r.querySelector('.score-cell')?.textContent.replace(/\s+/g, ' ').trim() }; }, id);
await page.waitForSelector(`#today-games tr[data-game-id="${act.id}"]`);
await page.waitForFunction(() => document.documentElement.dataset.live === 'online', null, { timeout: 8000 }).catch(() => {});
await page.evaluate(() => { window.__noReload = true; });
const f1 = await row(fin.id), a1 = await row(act.id);
ok(f1 && f1.result === 'final' && f1.score === '21–17 ✓ FINAL' && f1.winner === 'home', `completed game shows FINAL with its score, home first ("${f1?.score}")`);
ok(a1 && a1.result === 'live' && a1.score === '2–0 ● LIVE', `active game shows LIVE with the live score ("${a1?.score}")`);
const order = await page.evaluate(() => [...document.querySelectorAll('#today-games tr[data-game-id]')].map((r) => Number(r.dataset.gameId)));
ok(order.indexOf(fin.id) < order.indexOf(act.id), 'order: 05:00 before 06:00');
const t0 = Date.now();
await send({ type: 'cmd', cmd: { type: 'SCORE', team: 'away', pts: 3 } });
const live = await page.waitForFunction((id) => document.querySelector(`#today-games tr[data-game-id="${id}"] .score-cell`)?.textContent.includes('2–3'), act.id, { timeout: 5000 }).then(() => true).catch(() => false);
ok(live && await page.evaluate(() => window.__noReload === true), `score change shows live without a reload (${Date.now() - t0} ms)`);
const sw = await page.evaluate(() => ({ doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth], wrap: [...document.querySelectorAll('#today .tbl-wrap')].map((w) => [w.scrollWidth, w.clientWidth]) }));
ok(sw.doc[0] <= sw.doc[1] && sw.wrap.every(([s, c]) => s <= c), `390px: no horizontal scroll (page ${sw.doc.join('/')}, list ${sw.wrap.map((x) => x.join('/')).join(' ')})`);
await page.evaluate(() => document.querySelector('#today-games').closest('.tbl-wrap').scrollIntoView()); await sleep(200);
await page.screenshot({ path: `${OUT}/admin-today-390.png`, fullPage: false });
// complete -> FINAL, reopen -> LIVE again, both pushed live.
await api(`/api/games/${act.id}/complete`, { method: 'POST' });
const c2 = await page.waitForFunction((id) => document.querySelector(`#today-games tr[data-game-id="${id}"]`)?.dataset.result === 'final', act.id, { timeout: 5000 }).then(() => true).catch(() => false);
ok(c2 && (await row(act.id)).score === '2–3 ✓ FINAL', 'complete: row turns FINAL 2–3 live');
await api(`/api/games/${act.id}/reopen`, { method: 'POST', body: '{"force":true}' });
const r2 = await page.waitForFunction((id) => document.querySelector(`#today-games tr[data-game-id="${id}"]`)?.dataset.result === 'live', act.id, { timeout: 5000 }).then(() => true).catch(() => false);
ok(r2, 'reopen: row turns LIVE again live');
await send({ type: 'cmd', cmd: { type: 'SCORE', team: 'home', pts: 1 } });
await page.waitForFunction((id) => document.querySelector(`#today-games tr[data-game-id="${id}"] .score-cell`)?.textContent.includes('3–3'), act.id, { timeout: 5000 }).catch(() => {});
await api(`/api/games/${act.id}/complete`, { method: 'POST' });
const tie = await page.waitForFunction((id) => document.querySelector(`#today-games tr[data-game-id="${id}"]`)?.dataset.result === 'tie', act.id, { timeout: 5000 }).then(() => true).catch(() => false);
ok(tie && (await row(act.id)).score === '3–3 ✓ FINAL TIE', 'tied final shows FINAL + TIE');
// edit is pushed too: move the 06:00 game to 04:30 in Admin -> it jumps above the 05:00 final without a reload.
const at0430 = new Date(new Date(fin.scheduled_at).getTime() - 30 * 60_000).toISOString();
await api(`/api/games/${act.id}`, { method: 'PUT', body: JSON.stringify({ scheduled_at: at0430 }) });
const moved = await page.waitForFunction(([a, f]) => { const ids = [...document.querySelectorAll('#today-games tr[data-game-id]')].map((r) => Number(r.dataset.gameId)); return ids.indexOf(a) > -1 && ids.indexOf(a) < ids.indexOf(f); }, [act.id, fin.id], { timeout: 5000 }).then(() => true).catch(() => false);
ok(moved, 'edit (time 06:00 -> 04:30): order updates live (time slot, then court)');
await api(`/api/games/${act.id}`, { method: 'PUT', body: JSON.stringify({ scheduled_at: act.scheduled_at }) });
await api(`/api/games/${act.id}/reopen`, { method: 'POST', body: '{"force":true}' }); await sleep(400);
await page.evaluate(() => document.querySelector('#today-games').closest('.tbl-wrap').scrollIntoView()); await sleep(200);
await page.screenshot({ path: `${OUT}/admin-today-390-live.png` });
await page.evaluate(() => scrollTo(0, 0));
await page.setViewportSize({ width: 1440, height: 900 }); await sleep(400);
await page.screenshot({ path: `${OUT}/admin-today-1440.png` });
ok(await page.evaluate(() => window.__noReload === true), 'no reload during the whole run');
ws.close(); await browser.close();
await api(`/api/games/${act.id}/complete`, { method: 'POST' });
for (const g of mine) await api(`/api/games/${g.id}`, { method: 'DELETE' });
for (const t of [tA, tB]) await api(`/api/teams/${t}`, { method: 'DELETE' });
console.log(`\nAdmin Today e2e: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
