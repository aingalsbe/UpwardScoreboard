// Browser e2e (1920x1080) for the schedule paging rule: live + UP NEXT pinned and never translated, later upcoming
// paged, finals only in the leftover space ("▲ N earlier finals"), root data-phase. Builds its own Saturday
// (SCENE_DATE, default 2031-02-08) from the demo Saturday's matchups, then plays three scenes: early, midday, end.
// Screenshots: OUT_DIR (default docs/screenshots/schedule/paging)/{early,midday,midday-p2,end}.png. Repeatable (it deletes and
// recreates its own day; completes games left active on the floor, like the other e2e scripts).
// Usage: [BASE_URL=http://localhost:3000] [CHROME_PATH=/usr/bin/google-chrome] node scripts/schedule-paging-e2e.mjs
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import fs from 'node:fs';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const DATE = process.env.SCENE_DATE || '2031-02-08';
const OUT = process.env.OUT_DIR || 'docs/screenshots/schedule/paging';
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
const PIN_EAST = process.env.PIN_EAST || '3333';
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
const localDay = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).slice(0, 10);

// Fresh scene day: remove our old games, free the floor, copy the demo Saturday's matchups to DATE.
for (const g of (await api('/api/games')).filter((g) => g.scheduled_at && localDay(g.scheduled_at) === DATE)) await api(`/api/games/${g.id}`, { method: 'DELETE' });
for (const g of (await api('/api/games')).filter((g) => g.status === 'active' && ['West', 'East', 'Full'].includes(g.court))) await api(`/api/games/${g.id}/complete`, { method: 'POST' });
const sat = await api('/api/public/schedule?day=sat');
const games0 = (await api('/api/games')).filter((g) => g.scheduled_at && localDay(g.scheduled_at) === sat.date);
const rows = games0.map((g) => [DATE, new Date(g.scheduled_at).toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).slice(11, 16), g.court.toLowerCase(), g.grade, g.gender, g.home, g.away, g.cheer || ''].join(','));
const imp = await csv('date,time,court,grade,gender,home,away,cheer\n' + rows.join('\n') + '\n');
ok(imp.created === games0.length && games0.length >= 12, `scene day ${DATE}: ${imp.created} games copied from the demo Saturday (${sat.date})`);
const mine = (await api('/api/games')).filter((g) => g.scheduled_at && localDay(g.scheduled_at) === DATE);
const at = (time, court) => mine.find((g) => new Date(g.scheduled_at).toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).slice(11, 16) === time && g.court === court);
const finish = (list) => csv('id,status,home_score,away_score\n' + list.map(([g, h, a]) => `${g.id},complete,${h},${a}`).join('\n') + '\n');
async function live(g, pts) {
  await api(`/api/games/${g.id}/start`, { method: 'POST', body: '{"force":true}' });
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?court=east&role=score`); await new Promise((r) => ws.on('open', r));
  const send = (o) => new Promise((r) => { const id = Math.random().toString(36).slice(2); const h = (d) => { const m = JSON.parse(String(d)); if (m.type === 'auth' || (m.type === 'ack' && m.id === id)) { ws.off('message', h); r(m); } }; ws.on('message', h); ws.send(JSON.stringify({ ...o, id })); });
  await send({ type: 'auth', pin: PIN_EAST, device: 'paging-e2e' });
  for (const [team, p] of pts) await send({ type: 'cmd', cmd: { type: 'SCORE', team, pts: p } });
  await send({ type: 'cmd', cmd: { type: 'PERIOD', delta: 1 } }); await send({ type: 'cmd', cmd: { type: 'CLOCK_START' } });
  ws.close();
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
page.on('pageerror', (e) => ok(false, `page error: ${e.message}`));
fs.mkdirSync(OUT, { recursive: true });

const inspect = () => page.evaluate(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
  const view = document.querySelector('.sched-view').getBoundingClientRect();
  const key = [...document.querySelectorAll('.game[data-state="active"], .game[data-next="true"]')];
  const trackGames = [...document.querySelectorAll('.sched-track .game')];
  const pinnedEl = document.querySelector('.sched-pinned');
  return {
    phase: document.documentElement.dataset.phase, pages: document.documentElement.dataset.pages, page: document.documentElement.dataset.page,
    dots: document.querySelectorAll('.foot i').length, overflows: document.documentElement.classList.contains('overflows'),
    keyCount: key.length, keyInPinned: key.every((g) => g.closest('.sched-pinned') && !g.closest('.sched-track')),
    keyVisible: key.every((g) => { const b = g.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight && b.height > 0; }),
    keyRects: key.map(r), pinnedTransform: getComputedStyle(pinnedEl).transform, pinnedAncestorTrack: !!pinnedEl.closest('.sched-track'),
    pinnedOnlyKey: [...pinnedEl.querySelectorAll('.game')].every((g) => g.dataset.state === 'active' || g.dataset.next === 'true'),
    order: trackGames.map((g) => g.dataset.state),
    finalsShown: trackGames.filter((g) => g.dataset.state === 'complete').length,
    compact: document.querySelectorAll('.game[data-compact="true"]').length,
    compactOnlyFinals: [...document.querySelectorAll('.game[data-compact="true"]')].every((g) => g.dataset.state === 'complete'),
    // Finals live on the track's last page: inside [last page top, last page top + frame height].
    finalsFit: (() => { const t = document.querySelector('.sched-track'), offs = (t.dataset.offsets || '0').split(',').map(Number), last = offs.at(-1);
      const tt = t.getBoundingClientRect().top, vh = document.querySelector('.sched-view').clientHeight;
      return trackGames.filter((g) => g.dataset.state === 'complete').every((g) => { const b = g.getBoundingClientRect(); return b.top - tt >= last - 1 && b.bottom - tt <= last + vh + 1; }); })(),
    pinnedEmptySlots: document.querySelectorAll('.sched-pinned .slot[data-empty]').length,
    earlier: document.querySelector('.earlier').textContent,
    earlierBeforeFinals: (() => { const e = document.querySelector('.earlier'), f = document.querySelector('.sched-track .game[data-state="complete"]'); return !f || !!(e.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING); })(),
    times: trackGames.filter((g) => g.dataset.state === 'complete').map((g) => g.querySelector('[data-bind=time]').textContent),
  };
});
async function scene(name, expectPhase, totalFinals) {
  await page.goto(`${BASE}/schedule?date=${DATE}`); await page.waitForFunction(() => document.documentElement.dataset.conn === 'online'); await sleep(1500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const s = await inspect();
  console.log(`  [${name}] phase=${s.phase} pages=${s.pages} key=${s.keyCount} finalsShown=${s.finalsShown} earlier="${s.earlier}"`);
  ok(s.phase === expectPhase, `${name}: data-phase=${s.phase}`);
  ok(s.keyInPinned && s.pinnedOnlyKey && !s.pinnedAncestorTrack && s.pinnedTransform === 'none', `${name}: live + UP NEXT (${s.keyCount}) are all in .sched-pinned (untransformed, outside the track), nothing else is`);
  ok(s.keyVisible, `${name}: live + UP NEXT fully visible at 1920x1080`);
  ok(s.pinnedEmptySlots === 0, `${name}: no empty placeholder slots in .sched-pinned`);
  const firstFinal = s.order.indexOf('complete');
  ok(firstFinal === -1 || s.order.slice(firstFinal).every((x) => x === 'complete'), `${name}: track order = later upcoming, then finals`);
  const n = Number((s.earlier.match(/\d+/) || [0])[0]);
  ok(s.compact === s.finalsShown && s.compactOnlyFinals && s.finalsShown + n === totalFinals && s.finalsFit && s.earlierBeforeFinals, `${name}: finals ${s.finalsShown} shown (data-compact, all inside the frame) + ${n} collapsed = ${totalFinals}`);
  ok(s.overflows ? Number(s.pages) > 1 && s.dots === Number(s.pages) : s.pages === '1' && s.dots === 0, `${name}: paging only on overflow (pages=${s.pages}, dots=${s.dots})`);
  return s;
}

// Early: 8:00 East live, nothing complete.
await live(at('08:00', 'East'), [['home', 2], ['away', 2], ['home', 3]]);
const e = await scene('early', 'early', 0);
ok(e.keyCount >= 2 && Number(e.pages) > 1 && e.finalsShown === 0, 'early: upcoming alone overflow -> only the later upcoming page; live + next stay fixed');
// The rotation moves the track only: after one page turn the pinned games haven't moved.
await sleep(12_600);
const e2 = await inspect();
ok(e2.page !== e.page && JSON.stringify(e2.keyRects) === JSON.stringify(e.keyRects), `early: after a page turn (page ${e.page} -> ${e2.page}) live + next are exactly where they were`);
// Midday: 8:00 and 9:00 final, 10:00 West final, 10:00 East live.
await api(`/api/games/${at('08:00', 'East').id}/complete`, { method: 'POST' });
await finish([[at('08:00', 'West'), 24, 18], [at('09:00', 'West'), 20, 20], [at('09:00', 'East'), 14, 10], [at('10:00', 'West'), 16, 12]]);
await live(at('10:00', 'East'), [['home', 2], ['away', 3], ['home', 2]]);
const m = await scene('midday', 'midday', 5);
if (Number(m.pages) > 1) { await sleep(12_600); await page.screenshot({ path: `${OUT}/midday-p2.png` }); // the page with the finals
  const m2 = await inspect(); ok(m2.page === '1' && JSON.stringify(m2.keyRects) === JSON.stringify(m.keyRects), 'midday: page 2 (later upcoming + compact finals) leaves live + next where they were'); }
ok(m.compact >= 1, `midday: at least one compact final in the leftover space (${m.compact} shown: ${m.times.join(' ')})`);
// End: everything final.
await api(`/api/games/${at('10:00', 'East').id}/complete`, { method: 'POST' });
const open = (await api('/api/games')).filter((g) => g.scheduled_at && localDay(g.scheduled_at) === DATE && g.status === 'scheduled');
await finish(open.map((g, i) => [g, 10 + (i * 7) % 15, 12 + (i * 5) % 11]));
const end = await scene('end', 'end', mine.length);
ok(end.keyCount === 0 && end.finalsShown > 0 && Number(end.earlier.match(/\d+/)?.[0] || 0) > 0, 'end: nothing pinned, most recent finals fill the screen, the rest collapse');
ok(end.times.at(-1) === '6:30', `end: the last game of the day (6:30) is among the finals shown (${end.times.join(' ')})`);
await browser.close();
console.log(`\nSchedule paging e2e: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
