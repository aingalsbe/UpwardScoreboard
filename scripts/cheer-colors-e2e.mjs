// Browser e2e for cheer season colors (Morgan): Admin hex boxes save Cheer primary / secondary, and an open
// lobby, court TV, practice cheer and practice basketball pick them up LIVE (no reload). Restores the season.
// Usage: [BASE_URL=http://localhost:3000] [ADMIN_PASSWORD=change-me-admin] [CHROME_PATH=/usr/bin/google-chrome] node scripts/cheer-colors-e2e.mjs
import { pinBrowserClock } from './_gameday.mjs';
import { chromium } from 'playwright-core';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const rgbOf = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return ''; const n = parseInt(m[1], 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };
const normBg = (c) => { const m = String(c || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/); return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : c; };

const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let season0 = null, p = null;
try {
  const ctx = await b.newContext(); await pinBrowserClock(ctx);
  p = await ctx.newPage(); p.on('dialog', (d) => d.accept());
  await p.goto(BASE + '/admin'); await p.fill('#password', ADMIN); await p.click('#login button'); await p.waitForSelector('#app:not([hidden])');
  const call = (url, method = 'GET', body) => p.evaluate(async ([u, m, bd]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: bd }); return { status: r.status, body: await r.json().catch(() => null) }; }, [url, method, body ? JSON.stringify(body) : undefined]);
  const games = (await call('/api/games')).body;
  const g = Array.isArray(games) ? (games.find((x) => x.court && x.status === 'active') || games.find((x) => x.court)) : null;
  const slug = String(g?.court || 'full').toLowerCase();
  season0 = (await call('/api/settings/season')).body;

  const open = async (path) => { const pg = await ctx.newPage(); let loads = 0; pg.on('load', () => loads++); await pg.goto(BASE + path); await pg.waitForTimeout(1200); return { pg, loads: () => loads }; };
  const lobby = await open('/upwardbasketballscores/lobby?day=sat&at=10:00') // demo time with a seeded cheer slot, so a cheer row exists;
  const tv = await open(`/tv/${slug}`);
  const cheer = await open('/practice/cheer?day=mon&at=18:00');
  const ball = await open('/practice/basketball?day=mon&at=18:00');
  const pages = [['lobby', lobby], ['court TV', tv], ['practice/cheer', cheer], ['practice/basketball', ball]];

  await p.goto(BASE + '/admin#teams');
  await p.waitForSelector('#season-form [name=cheerPrimary]', { timeout: 8000 });
  ok(!!(await p.$('#season-cheer-primary')) && !!(await p.$('#season-form [name=cheerPrimary]')), 'Cheer primary swatch + hex box');
  ok(!!(await p.$('#season-cheer-secondary')) && !!(await p.$('#season-form [name=cheerSecondary]')), 'Cheer secondary swatch + hex box');
  ok((await p.inputValue('#season-form [name=cheerPrimary]')).toUpperCase() === String(season0.cheerPrimary || '').toUpperCase(), `cheer primary prefilled ${season0.cheerPrimary}`);
  ok((await p.inputValue('#season-form [name=cheerSecondary]')).toUpperCase() === String(season0.cheerSecondary || '').toUpperCase(), `cheer secondary prefilled ${season0.cheerSecondary}`);
  await p.fill('#season-form [name=cheerPrimary]', '#036');
  ok(await p.$eval('#season-cheer-primary', (e) => e.value) === '#003366', 'typing #036 sets the cheer primary swatch to #003366');
  await p.fill('#season-form [name=cheerPrimary]', 'blue');
  ok(/⚠ cheer primary:/.test(await p.textContent('#season-contrast')), 'invalid cheer hex is a warning row');
  await p.fill('#season-form [name=cheerPrimary]', '#FF00AA');
  await p.fill('#season-form [name=cheerSecondary]', '#00CCDD');
  const panel = await p.textContent('#season-contrast');
  ok(/Text on cheer primary \(auto (?:black|white)\): \d+\.\d+:1 ✔/.test(panel), 'contrast panel lists cheer primary');
  ok(/Text on cheer secondary \(auto (?:black|white)\): \d+\.\d+:1 ✔/.test(panel), 'contrast panel lists cheer secondary');

  const cssVar = (d, name) => d.pg.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toUpperCase(), name);
  const waitVar = async (d, name, want, ms = 5000) => { const t = Date.now(); let c; while (Date.now() - t < ms) { c = await cssVar(d, name); if (c === want) return c; await d.pg.waitForTimeout(150); } return c; };
  const homeBefore = await cssVar(tv, '--home-color'), awayBefore = await cssVar(tv, '--away-color');
  await p.$eval('#season-form', (f) => f.requestSubmit());
  let saved = null;
  for (let i = 0; i < 30; i++) { saved = (await call('/api/settings/season')).body; if (saved?.cheerPrimary === '#FF00AA' && saved?.cheerSecondary === '#00CCDD') break; await p.waitForTimeout(150); }
  ok(saved?.cheerPrimary === '#FF00AA' && saved?.cheerSecondary === '#00CCDD', `Save persists both cheer colors (${saved?.cheerPrimary} / ${saved?.cheerSecondary})`);
  ok(String(saved?.dark || '').toUpperCase() === String(season0.dark).toUpperCase() && String(saved?.light || '').toUpperCase() === String(season0.light).toUpperCase(), 'dark/light unchanged by the cheer save');

  for (const [n, d] of pages) {
    ok(await waitVar(d, '--season-cheer-primary', '#FF00AA') === '#FF00AA', `${n} --season-cheer-primary live`);
    ok(await waitVar(d, '--season-cheer-secondary', '#00CCDD') === '#00CCDD', `${n} --season-cheer-secondary live`);
    ok(d.loads() === 1, `${n} was never reloaded (${d.loads()} loads)`);
  }
  const rowBg = await lobby.pg.evaluate(() => [...document.querySelectorAll('.row.cheer')].map((e) => getComputedStyle(e).backgroundColor));
  ok(rowBg.length > 0 && rowBg.every((c) => normBg(c) === 'rgb(255, 0, 170)'), `lobby .row.cheer background = Cheer Primary (${rowBg.length} row(s), ${rowBg[0]})`);
  const rowFg = await lobby.pg.evaluate(() => [...document.querySelectorAll('.row.cheer')].map((e) => getComputedStyle(e).color));
  ok(rowFg.length > 0 && rowFg.every((c) => normBg(c) === 'rgb(0, 0, 0)'), `lobby .row.cheer text = auto fg black on #FF00AA (${rowFg[0]})`);
  const tvBg = normBg(await tv.pg.evaluate(() => { const e = document.querySelector('.cheer'); return e ? getComputedStyle(e).backgroundColor : ''; }));
  ok(tvBg === 'rgb(255, 0, 170)', `TV .cheer background = Cheer Primary (${tvBg})`);
  await cheer.pg.waitForSelector('.card .room', { timeout: 4000 }).catch(() => {});
  const rooms = await cheer.pg.evaluate(() => [...document.querySelectorAll('.card .room')].map((e) => getComputedStyle(e).backgroundColor));
  if (rooms.length >= 1) ok(normBg(rooms[0]) === 'rgb(255, 0, 170)', `practice cheer card 1 room = primary (${rooms[0]})`);
  if (rooms.length >= 2) ok(normBg(rooms[1]) === 'rgb(0, 204, 221)', `practice cheer card 2 room = secondary (${rooms[1]})`);
  await ball.pg.waitForSelector('.court', { timeout: 4000 }).catch(() => {});
  const courtBg = await ball.pg.evaluate(() => { const e = document.querySelector('.court'); return e ? getComputedStyle(e).backgroundColor : ''; });
  if (courtBg) ok(normBg(courtBg) === rgbOf(season0.light), `basketball .court stays season light (${courtBg})`);
  ok(await cssVar(tv, '--home-color') === homeBefore, `TV --home-color unchanged (${homeBefore})`);
  ok(await cssVar(tv, '--away-color') === awayBefore, `TV --away-color unchanged (${awayBefore})`);
} finally {
  try { if (season0 && p) await p.evaluate(async (body) => { await fetch('/api/settings/season', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }, season0); } catch { /* page may already be gone */ }
  await b.close();
}
console.log(`result: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
