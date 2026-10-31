// QA R29 (Sage NO-GO): the cheer practice page must keep every squad card (and its room) fully visible above the
// footer at every viewport; basketball pages likewise. Real 2027 season import (Mon 7 squads, Thu 3), plus a
// synthetic 9-squad night (the per-page maximum). Needs TEST_DATABASE_URL (own database "<name>_pfit", wiped) and
// Chrome (CHROME_PATH or /usr/bin/google-chrome). FIT_SCAN_OUT_PRACTICE=<file> writes the scan table as JSON.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ChildProcess } from 'node:child_process';
import pg from 'pg';
import { startServer } from './_server.js';

const BASE_URL = process.env.TEST_DATABASE_URL || '';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const skip = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test" (it is wiped)'
  : !fs.existsSync(CHROME) ? 'Chrome not found' : false;
let db: typeof import('../src/db.js');
let srv: ChildProcess | null = null;
let URL_ = '';

before(async () => {
  if (skip) return;
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_pfit'; u.pathname = '/' + name; URL_ = u.toString();
  const admin = new pg.Client({ connectionString: BASE_URL }); await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.DATABASE_URL = URL_; process.env.TZ = 'America/Chicago';
  db = await import('../src/db.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
after(async () => { srv?.kill(); await db?.pool.end(); });

const VPS: [number, number][] = [[1920, 1080], [1366, 768], [3840, 2160], [1280, 1024], [1080, 1920]];

test('practice pages fit the stage: every cheer card + room above the footer, 4 columns for 7+ squads (real season + 9-squad night)', { skip, timeout: 600_000 }, async () => {
  const season = await import('../src/seed-season.js');
  await db.migrate();
  await season.seedSeason({});
  // Synthetic Tuesday with 9 squads (the per-page max), long room names. Tuesday has hours but no cheer in the CSV.
  const squads = (await db.pool.query('SELECT id FROM cheer_squads ORDER BY id LIMIT 9')).rows.map((r) => r.id);
  assert.equal(squads.length, 9, 'the season has 9+ squads');
  for (const [i, id] of squads.entries()) await db.pool.query(`INSERT INTO practice_slots(day_of_week, kind, room, squad_id) VALUES (2,'cheer',$1,$2)`, [`Room ${100 + i}/${200 + i}`, id]);

  const s = await startServer({ DATABASE_URL: URL_, ADMIN_PASSWORD: 'pfit-admin', TZ: 'America/Chicago', SEED: '', SCOREBOARD_TEST_CLOCK: '1', SCOREBOARD_TEST_NOW: '2026-12-28T12:00:00-06:00' });
  srv = s.srv; const base = `http://127.0.0.1:${s.port}`;
  const pw: any = await import('playwright-core' as string);
  const browser = await pw.chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const measure = async (url: string) => {
    await page.goto(url);
    await page.waitForFunction(() => document.body.dataset.mode === 'practice' && document.querySelector('main')!.children.length > 0 && document.fonts.status === 'loaded', null, { timeout: 15_000 });
    await page.waitForTimeout(400);
    return page.evaluate(() => {
      const br = document.body.getBoundingClientRect(); const k = br.height / 1080;
      const st = (r: DOMRect) => ({ top: (r.top - br.top) / k, bottom: (r.bottom - br.top) / k, left: (r.left - br.left) / k, right: (r.right - br.left) / k });
      const foot = document.querySelector('footer')!; const fr = st(foot.getBoundingClientRect());
      const limit = foot.textContent!.trim() ? fr.top : 1080;
      let bottom = 0, right = 0;
      for (const el of document.querySelectorAll('main *')) { const r = el.getBoundingClientRect(); if (!r.height) continue; const x = st(r); bottom = Math.max(bottom, x.bottom); right = Math.max(right, x.right); }
      const clipped = [...document.querySelectorAll('main .room, main .team, main .coach, main .label')].filter((e: any) => e.scrollWidth > e.clientWidth + 1).map((e: any) => e.textContent);
      return { slack: Math.round(limit - bottom), right: Math.round(right), clipped, cards: document.querySelectorAll('main .card, main .court').length,
        rooms: [...document.querySelectorAll('main .card .room')].map((e) => e.textContent), cols: (document.querySelector('main') as any).dataset.cols || '',
        density: document.body.dataset.density || 'normal', k: (document.querySelector('main') as any).style.getPropertyValue('--fit-k') || '', header: document.querySelector('[data-bind="header"]')!.textContent };
    });
  };
  const scan: any[] = [];
  const check = (m: any, what: string) => {
    assert.ok(m.slack >= 0, `${what}: overflows the footer/stage by ${-m.slack}px (${m.density} ${m.k})`);
    assert.ok(m.right <= 1920, `${what}: runs off the right edge (${m.right})`);
    assert.deepEqual(m.clipped, [], `${what}: clipped text`);
  };
  for (const [w, h] of VPS) {
    await page.setViewportSize({ width: w, height: h });
    // Real-clock preview (Dec 28 -> Mon Jan 4, dated header) = Sage's repro, plus every practice day/slot via ?day=&at=.
    const urls: [string, string][] = [['cheer', '/practice/cheer'], ['basketball', '/practice/basketball']];
    for (const day of ['mon', 'tue', 'wed', 'thu']) for (const at of ['16:30', '17:00', '18:00', '19:00', '20:00', '21:00'])
      for (const kind of ['cheer', 'basketball']) urls.push([kind, `/practice/${kind}?day=${day}&at=${at}`]);
    for (const [kind, u] of urls) {
      const has = await (async () => { await page.goto(base + u); await page.waitForTimeout(700); return (await page.getAttribute('body', 'data-mode')) === 'practice'; })();
      if (!has) continue;
      const m = await measure(base + u);
      scan.push({ vp: `${w}x${h}`, kind, url: u, ...m });
      check(m, `${u} ${w}x${h}`);
      if (kind === 'cheer') assert.equal(m.cols, m.cards >= 7 ? '4' : '3', `${u} columns for ${m.cards} squads`);
    }
  }
  // Sage's repro: Monday (7 squads) shows all 7 rooms incl. Room 33/35; the 9-squad Tuesday shows all 9.
  const mon = scan.find((x) => x.vp === '1920x1080' && x.url === '/practice/cheer');
  assert.equal(mon.header.trim(), 'MON JAN 4 CHEER'); assert.equal(mon.cards, 7); assert.ok(mon.rooms.includes('Room 33/35'), mon.rooms.join(','));
  const tue = scan.find((x) => x.vp === '1920x1080' && x.url === '/practice/cheer?day=tue&at=18:00');
  assert.equal(tue.cards, 9);
  if (process.env.FIT_SCAN_OUT_PRACTICE) fs.writeFileSync(process.env.FIT_SCAN_OUT_PRACTICE, JSON.stringify(scan, null, 1));
  await browser.close();
});
