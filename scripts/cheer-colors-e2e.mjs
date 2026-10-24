// Browser e2e for cheer season colors (Morgan): Admin hex boxes save Cheer primary / secondary, and an open
// lobby, court TV, practice cheer and practice basketball pick them up LIVE (no reload). Restores the season.
// Round 2: mid-tone NEXT cheer contrast (no brightness filter), swatch sample color, primary-vs-secondary
// warning, and the white-swap info row. Restores the season (and completes games this script started).
// Usage: [BASE_URL=http://localhost:3000] [ADMIN_PASSWORD=change-me-admin] [CHROME_PATH=/usr/bin/google-chrome] node scripts/cheer-colors-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinBrowserClock } from './_gameday.mjs';
import { chromium } from 'playwright-core';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const rgbOf = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return ''; const n = parseInt(m[1], 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };
const normBg = (c) => { const m = String(c || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/); return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : c; };

const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let season0 = null, p = null, startedIds = [];
/** Locker "Locker Room" label + number vs the painted background (walk ancestors), plus filter/opacity and the dashed rim. */
const cheerContrast = (pg) => pg.evaluate(() => {
  const parse = (c) => { const m = String(c || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/); return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] == null ? 1 : +m[4] } : null; };
  const lum = (rgb) => { const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const p = parse(getComputedStyle(n).backgroundColor); if (p && p.a >= 0.99) return p.rgb; } return [0, 0, 0]; };
  const dim = (el) => { for (let n = el; n; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.filter && cs.filter !== 'none') return `filter ${cs.filter} on .${n.className}`; if (Number(cs.opacity) < 0.999) return `opacity ${cs.opacity} on .${n.className}`; } return ''; };
  const rgb = (c) => { const p = parse(c); return p ? `rgb(${p.rgb.join(', ')})` : String(c || ''); };
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
  return [...document.querySelectorAll('.cheer-band .row.cheer')].map((row) => {
    const cs = getComputedStyle(row);
    const label = row.querySelector('.locker small'), num = row.querySelector('.locker b');
    const one = (el) => { const fg = el && parse(getComputedStyle(el).color); return fg ? ratio(fg.rgb, bgOf(el)) : 0; };
    const borderColor = rgb(cs.borderTopColor), rowColor = rgb(cs.color);
    return {
      slot: row.closest('.cheer-band')?.classList.contains('next') ? 'next' : 'now',
      labelText: label?.textContent || '', dim: dim(row) || (label && dim(label)) || (num && dim(num)) || '',
      ratios: { label: one(label), num: one(num) },
      borderStyle: cs.borderTopStyle, borderWidth: cs.borderTopWidth, borderColor, rowColor,
      rim: cs.borderTopStyle === 'dashed' && Math.abs(parseFloat(cs.borderTopWidth) - 0.4 * rootPx) < 0.51 && borderColor === rowColor,
    };
  });
});
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
  ok(!/Cheer primary vs secondary only/.test(panel), 'no primary-vs-secondary warning for #FF00AA vs #00CCDD');
  const samples = () => p.$$eval('#season-form .season-swatch.cheer', (els) => els.map((el) => {
    const s = el.querySelector('.swatch-sample'), cs = getComputedStyle(s);
    return { color: cs.color.replace(/\s/g, ''), shadow: cs.textShadow, hex: (el.querySelector('input.hex')?.value || '').toUpperCase() };
  }));
  let sw = await samples();
  ok(sw.length === 2 && sw.every((s) => s.shadow === 'none'), `cheer swatch sample has no text-shadow (${sw.map((s) => s.shadow).join(' | ')})`);
  ok(sw.every((s) => s.color === 'rgb(0,0,0)'), `cheer sample text is auto black on #FF00AA/#00CCDD (${sw.map((s) => `${s.hex}=${s.color}`).join(', ')})`);

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

  // AC7 / AC8 / AC6: form-only (no save). Same colors do warn; gold vs maroon does not. Maroon swaps to white on black; gold does not.
  await p.fill('#season-form [name=cheerPrimary]', '#777777');
  await p.fill('#season-form [name=cheerSecondary]', '#777777');
  let warn = await p.textContent('#season-contrast');
  ok(/⚠ Cheer primary vs secondary only \d+\.\d+:1 — practice cards will look the same\./.test(warn), `primary vs secondary warning when the colors match (${(warn || '').split('\n').find((l) => /primary vs secondary/.test(l)) || warn})`);
  await p.fill('#season-form [name=cheerPrimary]', '#FFC72C');
  await p.fill('#season-form [name=cheerSecondary]', '#800000');
  warn = await p.textContent('#season-contrast');
  ok(!/Cheer primary vs secondary only/.test(warn), 'no primary-vs-secondary warning for #FFC72C vs #800000');
  ok(/ℹ Cheer secondary #800000 is only \d+\.\d+:1 on the black practice cards — shown as white there\./.test(warn), `white-swap info for #800000 (${(warn || '').match(/ℹ Cheer secondary[^\n]*/)?.[0] || 'missing'})`);
  ok(!/ℹ Cheer primary #FFC72C/.test(warn) && !/ℹ Cheer secondary #FFC72C/.test(warn), 'no white-swap info for #FFC72C');
  sw = await samples();
  ok(sw.find((s) => s.hex === '#FFC72C')?.color === 'rgb(0,0,0)' && sw.find((s) => s.hex === '#800000')?.color === 'rgb(255,255,255)', `sample text follows the auto pick (${sw.map((s) => `${s.hex}=${s.color}`).join(', ')})`);
  ok(sw.every((s) => s.shadow === 'none'), 'cheer sample text-shadow stays none on gold and maroon');

  // AC2 / AC3: demo reset (throwaway test DB only), start games 4 and 5 so the 09:00 cheer slot is "next".
  let resetNote = 'skipped (not the throwaway test db)';
  if (process.env.E2E_DESTRUCTIVE === '1') {
    let dbName = ''; try { dbName = decodeURIComponent(new URL(process.env.DATABASE_URL || '').pathname.replace(/^\//, '')); } catch { /* unset */ }
    if (/(^|_)test(_|$)/i.test(dbName)) {
      const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/src/seed-demo.js');
      const r = await new Promise((resolve) => {
        const c = spawn(process.execPath, [script, '--reset'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
        c.on('close', (code) => resolve({ code, out }));
      });
      resetNote = r.code === 0 ? 'reset' : `failed ${r.code}: ${String(r.out).slice(-300)}`;
    }
  }
  ok(resetNote === 'reset' || resetNote.startsWith('skipped'), `demo ${resetNote}`);
  const localHm = (iso) => { try { return new Date(iso).toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).slice(11, 16); } catch { return ''; } };
  for (const g of (await call('/api/games')).body || []) if (g.status === 'active' && ['West', 'East', 'Full'].includes(g.court)) await call(`/api/games/${g.id}/complete`, 'POST');
  const gamesNow = (await call('/api/games')).body || [];
  const pair = [4, 5].map((id) => gamesNow.find((g) => g.id === id));
  const pairOk = pair.every((g) => g && ['West', 'East'].includes(g.court) && localHm(g.scheduled_at) === '08:00');
  ok(pairOk, `games 4 and 5 are 08:00 West/East (${pair.map((g) => g ? `#${g.id} ${g.court} ${localHm(g.scheduled_at)}` : 'missing').join(', ')})`);
  const targets = pairOk ? pair : gamesNow.filter((g) => ['West', 'East'].includes(g.court) && localHm(g.scheduled_at) === '08:00');
  for (const g of targets) {
    const r = await call(`/api/games/${g.id}/start`, 'POST', { force: true });
    if (r.status === 200) startedIds.push(g.id);
  }
  ok(startedIds.length >= 2, `started the 08:00 games so 09:00 cheer is next (${startedIds.join(', ') || 'none'})`);
  const liveLobby = await open('/upwardbasketballscores/lobby?day=sat');
  const bothLobby = await open('/upwardbasketballscores/lobby?day=sat&at=11:05'); // now (11:00) and next (12:00) both have a cheer squad
  await liveLobby.pg.waitForSelector('.cheer-band.next .row.cheer', { timeout: 8000 }).catch(() => {});
  const nextBar = await liveLobby.pg.textContent('.next-bar').catch(() => '');
  ok(/9:00\s*AM/.test(nextBar || ''), `09:00 slot is UP NEXT (${(nextBar || '').replace(/\s+/g, ' ')})`);
  const checkSlots = (name, rows, need) => {
    for (const slot of need) {
      const hit = rows.filter((r) => r.slot === slot);
      ok(hit.length >= 1, `${name} has a ${slot} cheer row`);
      for (const r of hit) {
        ok(!r.dim, `${name} ${slot} cheer row is not filtered or faded${r.dim ? ` (${r.dim})` : ''}`);
        ok(r.labelText.trim() === 'Locker Room', `${name} ${slot} label is "Locker Room" (${r.labelText})`);
        ok(r.ratios.label >= 4.5 && r.ratios.num >= 4.5, `${name} ${slot} locker label/number ≥4.5:1 (${Number(r.ratios.label).toFixed(2)} / ${Number(r.ratios.num).toFixed(2)})`);
        ok(r.rim, `${name} ${slot} .4rem dashed border in the row fg (${r.borderStyle} ${r.borderWidth} ${r.borderColor} vs ${r.rowColor})`);
      }
    }
  };
  for (const hex of ['#FF00AA', '#777777', '#7A7A7A']) {
    const put = await call('/api/settings/season', 'PUT', { name: season0.name, dark: season0.dark, light: season0.light, cheerPrimary: hex, cheerSecondary: season0.cheerSecondary });
    ok(put.status === 200 && put.body?.cheerPrimary === hex, `PUT cheer primary ${hex}`);
    ok(await waitVar(liveLobby, '--season-cheer-primary', hex) === hex, `started-games lobby picked up ${hex}`);
    ok(await waitVar(bothLobby, '--season-cheer-primary', hex) === hex, `11:05 demo lobby picked up ${hex}`);
    checkSlots(`${hex} started-games lobby`, await cheerContrast(liveLobby.pg), ['next']);
    checkSlots(`${hex} 11:05 demo lobby`, await cheerContrast(bothLobby.pg), ['now', 'next']);
  }
} finally {
  try { for (const id of startedIds) await p?.evaluate(async (i) => { await fetch(`/api/games/${i}/complete`, { method: 'POST' }); }, id); } catch { /* page may already be gone */ }
  try { if (season0 && p) await p.evaluate(async (body) => { await fetch('/api/settings/season', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }, season0); } catch { /* page may already be gone */ }
  await b.close();
}
console.log(`result: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
