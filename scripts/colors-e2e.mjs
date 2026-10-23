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
  // 9) EVERY screen (Aaron: season colors only): lobby, both practice TVs, court TV, overlay, scorekeeper, admin and the
  //    practice editor start on the season colors (inline <style id="season-vars">) and follow a season save LIVE.
  await call('/api/settings/season', 'PUT', { name: season0.name, dark: '#4E7AFD', light: '#FFC72C' });
  const SCREENS = { lobby: '/upwardbasketballscores/lobby', 'practice/basketball': '/practice/basketball', 'practice/cheer': '/practice/cheer',
    'court TV': `/tv/${slug}`, overlay: `/overlay/${slug}`, scorekeeper: `/score/${slug}`, admin: '/admin', 'admin/practice': '/admin/practice' };
  const scr = {}; for (const [n, path] of Object.entries(SCREENS)) scr[n] = await open(path);
  const vars = (d) => d.pg.evaluate(() => { const cs = getComputedStyle(document.documentElement); return [cs.getPropertyValue('--season-light').trim().toUpperCase(), cs.getPropertyValue('--season-dark').trim().toUpperCase()]; });
  const waitVars = async (d, want, ms = 5000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await vars(d); if (v[0] === want[0] && v[1] === want[1]) return v; await d.pg.waitForTimeout(150); } return v; };
  for (const [n, d] of Object.entries(scr)) ok((await waitVars(d, ['#FFC72C', '#4E7AFD'])).join() === '#FFC72C,#4E7AFD', `${n} starts on the season #FFC72C / #4E7AFD`);
  // the lobby's rows really paint with them (away row = season dark, home row = season light; no fixed maroon/gold)
  const rowBg = (sel) => scr.lobby.pg.evaluate((q) => [...document.querySelectorAll(q)].map((e) => getComputedStyle(e).backgroundColor), sel);
  const hasAway = (await rowBg('.row.away')).length > 0;
  if (hasAway) ok((await rowBg('.row.away')).every((c) => c === 'rgb(78, 122, 253)'), 'lobby away rows = season dark #4E7AFD');
  if (hasAway) ok((await rowBg('.row.home')).every((c) => c === 'rgb(255, 199, 44)'), 'lobby home rows = season light #FFC72C');
  const css0 = await (await fetch(BASE + '/lobby.css')).text();
  ok(!/#800000|#f47cc6/i.test(css0.replace(/\/\*[\s\S]*?\*\//g, '')), 'lobby.css has no fixed maroon/pink outside comments');
  const r9 = await call('/api/settings/season', 'PUT', { name: season0.name, dark: '#224466', light: '#FFDD88' });
  ok(r9.status === 200, 'season changed to #FFDD88 / #224466');
  for (const [n, d] of Object.entries(scr)) ok((await waitVars(d, ['#FFDD88', '#224466'])).join() === '#FFDD88,#224466', `${n} follows the season change live`);
  if (hasAway) ok((await rowBg('.row.away')).every((c) => c === 'rgb(34, 68, 102)'), 'lobby away rows repainted #224466 live');
  for (const [n, d] of Object.entries(scr)) ok(d.loads() === 1, `${n} was never reloaded`);
  // HTML can't go stale after a deploy: no-cache + must-revalidate; JS/CSS revalidate with an ETag (304)
  const h = await fetch(BASE + '/upwardbasketballscores/lobby');
  ok(/no-cache/.test(h.headers.get('cache-control') || '') && /must-revalidate/.test(h.headers.get('cache-control') || ''), `lobby HTML cache-control "${h.headers.get('cache-control')}"`);
  ok((await h.text()).includes('--season-dark:#224466'), 'lobby HTML carries the current season colors inline');
  const a = await fetch(BASE + '/lobby.js'), et = a.headers.get('etag');
  ok(/no-cache/.test(a.headers.get('cache-control') || '') && !!et, `lobby.js no-cache with ETag ${et}`);
  ok((await fetch(BASE + '/lobby.js', { headers: { 'if-none-match': et } })).status === 304, 'unchanged lobby.js revalidates as 304');
  for (const d of Object.values(scr)) await d.pg.close();
  // 10) Avery round 21 (P2 contrast): text on season-colored bars stays >= 4.5:1 for near-identical light seasons
  //     (#FFF5CC/#FFF0B0) and near-black seasons (#010101/#000000); fg auto-picks black or white.
  const CONTRAST = () => {
    const rgb = (c) => { const m = c.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/); if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] === undefined ? 1 : +m[4]];
      const n = (c.match(/[\d.]+/g) || []).map(Number); return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]; };
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    window.__ratio = (sel) => { const el = document.querySelector(sel); if (!el) return null; const fg = rgb(getComputedStyle(el).color);
      let e = el, bg = [0, 0, 0, 0]; while (e) { bg = rgb(getComputedStyle(e).backgroundColor); if (bg[3] > 0.5) break; e = e.parentElement; } if (!e) bg = [255, 255, 255, 1];
      const a = lum(fg), b = lum(bg); return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100; };
  };
  const tv10 = await open(`/tv/${slug}`), pr10 = await open('/practice/basketball');
  for (const d of [tv10, pr10]) await d.pg.evaluate(CONTRAST);
  // the practice idle card only renders when idle: make sure one is on the page (same markup as practice.js)
  await pr10.pg.evaluate(() => { if (!document.querySelector('.idle-next')) document.body.insertAdjacentHTML('beforeend', '<main class="idle"><div class="idle-card"><div class="idle-title">No practice right now</div><div class="idle-next">Next: probe</div></div></main>'); });
  const ELS = [[tv10, '.next-up-label'], [tv10, '.ticker'], [tv10, '.ticker b'], [pr10, '.idle-next']];
  for (const [light, dark] of [['#FFF5CC', '#FFF0B0'], ['#010101', '#000000']]) {
    const r10 = await call('/api/settings/season', 'PUT', { name: season0.name, dark, light });
    ok(r10.status === 200, `Avery season ${light}/${dark} saves (a warning, not a block)`);
    for (const d of [tv10, pr10]) await waitVars(d, [light, dark]);
    for (const [d, sel] of ELS) { const r = await d.pg.evaluate((q) => window.__ratio(q), sel); ok(r >= 4.5, `${light}/${dark}: ${sel} contrast ${r}:1 >= 4.5`); }
  }
  await tv10.pg.close(); await pr10.pg.close();
  // admin warns (does not block) when light vs dark is under 1.5:1
  await p.goto(BASE + '/admin#teams'); await p.waitForTimeout(800);
  await p.fill('#season-form [name=dark]', '#FFF0B0'); await p.fill('#season-form [name=light]', '#FFF5CC');
  ok(/under 1\.5:1/.test(await p.textContent('#season-contrast')), 'admin warns: light vs dark under 1.5:1');
  await p.$eval('#season-form', (f) => f.requestSubmit()); await p.waitForTimeout(800);
  ok((await call('/api/settings/season')).body.light === '#FFF5CC', 'low-contrast season still saved (warning only)');
  // P3: the 10 s background reload prefills only untouched fields; a half-typed value survives
  await p.goto(BASE + '/admin#teams'); await p.waitForTimeout(800);
  await p.click('#season-form [name=light]'); await p.keyboard.press('Control+A'); await p.keyboard.type('#12');
  await call('/api/settings/season', 'PUT', { name: season0.name, dark: '#224466', light: '#FFDD88' });
  await p.waitForTimeout(11500);
  ok(await p.inputValue('#season-form [name=light]') === '#12', 'typed season light kept across the background reload');
  ok(/#224466/i.test(await p.inputValue('#season-form [name=dark]')), 'untouched season dark was refreshed to #224466');
  // 11) Avery R21b: idle -> game and game -> idle -> game on /upwardbasketballscores/westcourt keep the derived
  //     panel fg (contrast.js) — team names and fouls stay >= 4.5:1 for season #FFF0B0 / #010101.
  await call('/api/settings/season', 'PUT', { name: season0.name, light: '#FFF0B0', dark: '#010101' });
  const courts = (await call('/api/courts')).body, west = courts.find((c) => c.slug === 'west');
  for (const x of (await call('/api/games')).body) if (x.court_id === west.id && x.status === 'active') await call(`/api/games/${x.id}/complete`, 'POST');
  const tms = (await call('/api/teams')).body.slice(0, 4);
  const day = new Date(); do day.setDate(day.getDate() + 1); while (day.getDay() !== 6); day.setHours(10, 0, 0, 0); const base = day.getTime(); // next Saturday 10:00, inside game hours
  // W1 normal, W2 swapped (home wears the season dark, where the #111 fallback would be unreadable)
  let mkErr = '';
  // first free hour 08:00-18:00 on one of the next 4 Saturdays (seeded data already uses some West slots)
  const used = new Set();
  const mk = async (h, a, swap) => { for (let hr = 0; hr < 4 * 24; hr++) { if (used.has(hr) || hr % 24 > 10) continue; const r = await call('/api/games', 'POST', { court_id: west.id, home_team_id: h.id, away_team_id: a.id, swap_colors: swap, scheduled_at: new Date(base - 2 * 3600e3 + (hr % 24) * 3600e3 + Math.floor(hr / 24) * 7 * 864e5).toISOString() }); if (r.body?.id) { used.add(hr); used.add(hr + 1); used.add(hr - 1); return r.body.id; } mkErr = `${r.status} ${JSON.stringify(r.body)}`; } };
  const W1 = await mk(tms[0], tms[1], false), W2 = await mk(tms[0], tms[1], true);
  ok(W1 && W2, `two West games created (2nd swapped) (${W1}, ${W2}) ${mkErr}`);
  const wtv = await open('/upwardbasketballscores/westcourt'); await wtv.pg.evaluate(CONTRAST);
  const status = () => wtv.pg.evaluate(() => document.documentElement.dataset.status);
  const waitStatus = async (want) => { for (let i = 0; i < 60 && (await status()) !== want; i++) await wtv.pg.waitForTimeout(100); return status(); };
  ok((await waitStatus('idle')) === 'idle', 'West TV starts idle (no game)');
  const SEL = ['[data-bind="home.name"]', '[data-bind="away.name"]', '[data-bind="home.fouls"]', '[data-bind="away.fouls"]'];
  const check = async (when) => { await wtv.pg.waitForTimeout(400); for (const q of SEL) { const r = await wtv.pg.evaluate((x) => window.__ratio(x), q); ok(r >= 4.5, `${when}: ${q} ${r}:1 >= 4.5`); }
    // the derived vars must really be there (not the CSS #111/#fff fallback that only happens to read on some seasons)
    const v = await wtv.pg.evaluate(() => ['home', 'away'].map((s) => document.documentElement.style.getPropertyValue(`--${s}-fg`)));
    ok(v.every(Boolean), `${when}: contrast.js --home-fg/--away-fg set (${v.join(' / ')})`); };
  await call(`/api/games/${W1}/start`, 'POST', { force: true }); await waitStatus('active'); await check('idle -> game');
  await call(`/api/games/${W1}/complete`, 'POST'); ok((await waitStatus('idle')) === 'idle', 'West TV back to idle');
  await call(`/api/games/${W2}/start`, 'POST', { force: true }); await waitStatus('active'); await check('game -> idle -> game');
  ok(wtv.loads() === 1, 'West TV never reloaded');
  await call(`/api/games/${W2}/complete`, 'POST'); await wtv.pg.close();
  await call('/api/settings/season', 'PUT', season0);
} finally { await b.close(); }
console.log(`result: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
