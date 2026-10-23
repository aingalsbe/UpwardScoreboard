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

  // 1-6) per-game colors are retired (Aaron): no color fields in the game form; a game color sent to the API is ignored
  //      with a note (no 400), never returned, and every display keeps the season colors.
  await edit();
  ok(!(await p.$('#game-form [name=homeColor]')) && !(await p.$('#game-form [name=awayColor]')) && !(await p.$('#game-form [data-hex-for]')), 'game form has no Home/Away color fields or hex boxes');
  ok(!!(await p.$('#game-form [name=homeName]')) && !!(await p.$('#game-form [name=swap_colors]')), 'display names and Swap colors stay');
  await p.click('#game-save'); await p.waitForTimeout(500);
  const seasonHome = (g.swap_colors ? season0.dark : season0.light).toUpperCase(), seasonAway = (g.swap_colors ? season0.light : season0.dark).toUpperCase();
  for (const th of [{ homeColor: '#1e90ff', awayColor: '#F0a' }, { homeColor: 'rgb(30,144,255)' }]) {
    const r = await call(`/api/games/${g.id}`, 'PUT', { court_id: g.court_id, home_team_id: g.home_team_id, away_team_id: g.away_team_id, scheduled_at: at, division: g.division ?? '', theme: th });
    ok(r.status === 200 && (r.body.warnings || []).some((w) => /game colors ignored/.test(w)), `API ${JSON.stringify(th)} -> 200 with a note (${r.status})`);
  }
  const t1 = await theme(); ok(!('homeColor' in t1) && !('awayColor' in t1), `GET /api/games returns no game colors (${JSON.stringify(t1)})`);
  await p.waitForTimeout(800);
  for (const [n, d] of Object.entries(D)) {
    ok(await css(d, '--home-color') === seasonHome, `${n} --home-color stays the season ${seasonHome}`);
    ok(await css(d, '--away-color') === seasonAway, `${n} --away-color stays the season ${seasonAway}`);
  }
  // 7) season colors through the hex box (TV away = dark)
  await p.goto(BASE + '/admin#teams'); await p.waitForTimeout(600);
  ok(await p.inputValue('#season-form [name=dark]') === season0.dark.toUpperCase(), `season dark hex box shows ${season0.dark}`);
  await p.fill('#season-form [name=dark]', '#036'); ok(await p.$eval('#season-dark', (e) => e.value) === '#003366', 'season swatch follows the hex box');
  await p.$eval('#season-form', (f) => f.requestSubmit()); await p.waitForTimeout(600);
  ok((await call('/api/settings/season')).body.dark === '#003366', 'season dark saved as #003366');
  ok(await waitCss(tv, g.swap_colors ? '--home-color' : '--away-color', '#003366') === '#003366', 'TV shows the new season dark live');
  for (const [n, d] of Object.entries(D)) ok(d.loads() === 1, `${n} was never reloaded`);
  // 8) Admin team list (Aaron: season colors only): every row shows the season light/dark hex, live after saves
  const RUN = Date.now().toString(36).slice(-5);
  const tNew = (await call('/api/teams', 'POST', { name: `Swatch-${RUN}`, short_name: 'SW', grade: '3rd Grade', gender: 'Boys' })).body.id;
  await p.goto(BASE + '/admin#teams'); await p.waitForTimeout(800);
  let adminLoads = 0; p.on('load', () => adminLoads++);
  const rows = () => p.evaluate(() => [...document.querySelectorAll('#team-rows .team-color')].map((e) => ({ title: e.title, text: e.textContent.trim(), bg: e.querySelector('.swatch').style.background })));
  const nTeams = await p.evaluate(() => document.querySelectorAll('#team-rows tr').length);
  const waitAll = async (want, ms = 5000) => { const t = Date.now(); let r; while (Date.now() - t < ms) { r = await rows(); if (r.length === nTeams && r.every((x) => x.text === want)) return r; await p.waitForTimeout(150); } return r; };
  let rw = await waitAll(`${season0.light.toUpperCase()} / #003366`);
  ok(rw.length === nTeams && rw.every((x) => x.text === `${season0.light.toUpperCase()} / #003366` && /Season colors: light .* \(home\) \/ dark #003366 \(away\)/.test(x.title)), `all ${nTeams} team rows show the season hex "${rw[0]?.text}"`);
  ok(!(await p.$('#team-rows .season-tag')) && !/season default/i.test(await p.textContent('#team-rows')), 'no "season default" tag');
  await p.fill('#season-form [name=light]', '#FC3'); await p.$eval('#season-form', (f) => f.requestSubmit());
  rw = await waitAll('#FFCC33 / #003366');
  ok(rw.every((x) => x.text === '#FFCC33 / #003366' && /255, 204, 51/.test(x.bg)), `after a season save every row shows ${rw[0]?.text} live`);
  // a team color sent through the API is ignored (note in the response) and changes nothing on the list
  const put = await call(`/api/teams/${tNew}`, 'PUT', { name: `Swatch-${RUN}`, short_name: 'SW', grade: '3rd Grade', gender: 'Boys', primary_color: '#1e90ff', secondary_color: '#fff' });
  ok(put.status === 200 && /ignored/.test(put.body?.warnings?.[0] || ''), `team color via API ignored with a note: "${put.body?.warnings?.[0]}"`);
  await p.waitForTimeout(800);
  ok((await rows()).every((x) => x.text === '#FFCC33 / #003366') && !/1E90FF/i.test(await p.textContent('#team-rows')), 'list still shows the season colors only');
  ok(adminLoads === 0, 'admin page was not reloaded');
  await call(`/api/teams/${tNew}`, 'DELETE');
  await call('/api/settings/season', 'PUT', season0);
} finally { await b.close(); }
console.log(`result: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
