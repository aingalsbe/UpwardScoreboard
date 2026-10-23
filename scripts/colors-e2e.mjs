// Browser e2e for Aaron's color bug (c5882fa): the hex box in Admin saves (#RGB/#RRGGBB, stored uppercase), the
// native swatch stays in sync, Edit pre-fills and keeps the colors, and an open TV, overlay and scorekeeper pick up
// a color change LIVE (WebSocket, no reload). Also season colors. Uses the seeded data; restores the season at the end.
// Usage: [BASE_URL=http://localhost:3000] [CHROME_PATH=/usr/bin/google-chrome] node scripts/colors-e2e.mjs  (or scripts/run-e2e.sh colors-e2e.mjs)
import { pinBrowserClock } from './_gameday.mjs';
import { chromium } from 'playwright-core';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
const PINS = { full: '1111', west: '2222', east: '3333' };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  const ctx = await b.newContext(); await pinBrowserClock(ctx);
  const p = await ctx.newPage(); p.on('dialog', (d) => d.accept());
  await p.goto(BASE + '/admin'); await p.fill('#password', ADMIN); await p.click('#login button'); await p.waitForSelector('#app:not([hidden])');
  const call = (url, method = 'GET', body) => p.evaluate(async ([u, m, bd]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: bd }); return { status: r.status, body: await r.json().catch(() => null) }; }, [url, method, body ? JSON.stringify(body) : undefined]);
  const games = (await call('/api/games')).body;
  let g = games.find((x) => x.court && x.status === 'active') || games.find((x) => x.court && x.status === 'scheduled');
  if (g.status !== 'active') await call(`/api/games/${g.id}/start`, 'POST', { force: true });
  const slug = g.court.toLowerCase();
  const season0 = (await call('/api/settings/season')).body;
  // Open displays (each counts its page loads so we can prove there was no reload)
  const open = async (path) => { const pg = await ctx.newPage(); let loads = 0; pg.on('load', () => loads++); await pg.goto(BASE + path); await pg.waitForTimeout(1200); return { pg, loads: () => loads }; };
  const tv = await open(`/tv/${slug}`), ov = await open(`/overlay/${slug}`), sc = await open(`/score/${slug}`);
  if (await sc.pg.isVisible('#pin')) { await sc.pg.fill('#pin', PINS[slug]); await sc.pg.press('#pin', 'Enter'); await sc.pg.waitForTimeout(1200); }
  const css = (d, v) => d.pg.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toUpperCase(), v);
  const waitCss = async (d, v, want, ms = 4000) => { const t = Date.now(); let c; while (Date.now() - t < ms) { c = await css(d, v); if (c === want) return c; await d.pg.waitForTimeout(150); } return c; };
  const D = { TV: tv, overlay: ov, scorekeeper: sc };
  const edit = async () => { await p.goto(BASE + '/admin#schedule'); await p.waitForTimeout(600); await p.evaluate((id) => { const e = [...document.querySelectorAll(`[data-edit-game="${id}"]`)]; (e.find((x) => x.offsetParent) || e[0]).click(); }, g.id); await p.waitForTimeout(200); await p.$eval('#game-form details', (d) => { d.open = true; }); };
  const at = g.scheduled_at ? new Date(g.scheduled_at).toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).slice(0, 16).replace(' ', 'T') : null;
  const theme = async () => (await call('/api/games')).body.find((x) => x.id === g.id).theme || {};

  // 1) type lowercase hex -> use ticks, swatch syncs, saves uppercase, displays update live
  await edit();
  await p.fill('#game-form [name=homeColor]', '#1e90ff');
  ok(await p.$eval('[name=useHomeColor]', (e) => e.checked), 'typing a hex ticks "use" automatically');
  ok(await p.$eval('#game-form [data-hex-for=homeColor]', (e) => e.value) === '#1e90ff', 'native swatch follows the hex box');
  await p.click('#game-save'); await p.waitForTimeout(500);
  ok((await theme()).homeColor === '#1E90FF', `saved as uppercase #1E90FF (${JSON.stringify(await theme())})`);
  for (const [n, d] of Object.entries(D)) ok(await waitCss(d, '--home-color', '#1E90FF') === '#1E90FF', `${n} --home-color is #1E90FF live`);
  // 2) pick from the swatch -> hex box syncs, saves, live
  await edit();
  ok(await p.inputValue('#game-form [name=homeColor]') === '#1E90FF' && await p.$eval('[name=useHomeColor]', (e) => e.checked), 'Edit pre-fills the hex box and the use box');
  await p.$eval('#game-form [data-hex-for=homeColor]', (e) => { e.value = '#00aa55'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  ok(await p.inputValue('#game-form [name=homeColor]') === '#00AA55', 'swatch pick writes #00AA55 into the hex box');
  await p.click('#game-save'); await p.waitForTimeout(500);
  for (const [n, d] of Object.entries(D)) ok(await waitCss(d, '--home-color', '#00AA55') === '#00AA55', `${n} --home-color is #00AA55 live`);
  // 3) #RGB shorthand on away
  await edit(); await p.fill('#game-form [name=awayColor]', '#F0a'); await p.click('#game-save'); await p.waitForTimeout(500);
  ok((await theme()).awayColor === '#FF00AA', '#F0a saved as #FF00AA');
  ok(await waitCss(tv, '--away-color', '#FF00AA') === '#FF00AA', 'TV --away-color is #FF00AA live');
  // 4) re-save without touching colors keeps them (used to wipe them)
  await edit(); await p.click('#game-save'); await p.waitForTimeout(500);
  const t4 = await theme(); ok(t4.homeColor === '#00AA55' && t4.awayColor === '#FF00AA', 'Edit + Save without touching colors keeps them');
  // 5) bad hex: box flagged invalid, form not submitted; API says 400 with the reason
  await edit(); await p.fill('#game-form [name=homeColor]', '#12');
  ok(await p.$eval('#game-form [name=homeColor]', (e) => !e.checkValidity()), 'bad hex #12 is flagged in the form');
  const bad = await call(`/api/games/${g.id}`, 'PUT', { court_id: g.court_id, home_team_id: g.home_team_id, away_team_id: g.away_team_id, scheduled_at: at, division: g.division ?? '', theme: { homeColor: 'rgb(30,144,255)' } });
  ok(bad.status === 400 && /is not a color; use hex like #1E90FF/.test(bad.body?.error || ''), `API 400: ${bad.body?.error}`);
  // 6) clearing the box goes back to the season color
  await p.fill('#game-form [name=homeColor]', ''); ok(!(await p.$eval('[name=useHomeColor]', (e) => e.checked)), 'clearing the hex unticks "use"');
  await p.click('#game-save'); await p.waitForTimeout(500);
  ok(!(await theme()).homeColor, 'home override removed');
  const seasonHome = (g.swap_colors ? season0.dark : season0.light).toUpperCase();
  ok(await waitCss(tv, '--home-color', seasonHome) === seasonHome, `TV back to the season color ${seasonHome} live`);
  // 7) season colors through the hex box (TV away = dark)
  await p.goto(BASE + '/admin#teams'); await p.waitForTimeout(600);
  ok(await p.inputValue('#season-form [name=dark]') === season0.dark.toUpperCase(), `season dark hex box shows ${season0.dark}`);
  await p.fill('#season-form [name=dark]', '#036'); ok(await p.$eval('#season-dark', (e) => e.value) === '#003366', 'season swatch follows the hex box');
  await p.$eval('#season-form', (f) => f.requestSubmit()); await p.waitForTimeout(600);
  ok((await call('/api/settings/season')).body.dark === '#003366', 'season dark saved as #003366');
  // drop the away override so the TV shows the season dark again
  await call(`/api/games/${g.id}`, 'PUT', { court_id: g.court_id, home_team_id: g.home_team_id, away_team_id: g.away_team_id, scheduled_at: at, division: g.division ?? '', theme: {} });
  ok(await waitCss(tv, g.swap_colors ? '--home-color' : '--away-color', '#003366') === '#003366', 'TV shows the new season dark live');
  for (const [n, d] of Object.entries(D)) ok(d.loads() === 1, `${n} was never reloaded`);
  await call('/api/settings/season', 'PUT', season0);
} finally { await b.close(); }
console.log(`result: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
