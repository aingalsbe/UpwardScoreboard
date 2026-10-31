// Season practice range (settings practice_start/practice_end, written by the season importer from the practice CSVs).
// The lobby idle line and the Practice screens count from the shown day (or ?at=) and never show a practice outside
// the range; with no range (demo data) practice stays weekly. Unit tests always run; the DB + browser part needs
// TEST_DATABASE_URL (own database "<name>_prange", wiped) and Chrome (CHROME_PATH or /usr/bin/google-chrome).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { practiceDisplayOf } from '../src/practice.js';
import { buildSeasonPlan, readSeasonCsvs, practiceRangeOf, formatSeasonReport } from '../src/season-import.js';
import { startServer } from './_server.js';
import { LOCKER_ROOMS, teamLocker, cheerLocker } from '../src/season-config.js';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const noPub = !fs.existsSync(path.join(PUB, 'next-event.js')) && 'public/ not present';
const ev = () => import(path.join(PUB, 'next-event.js'));
const pv = () => import(path.join(PUB, 'practice-view.js'));
const RANGE = { start: '2027-01-04', end: '2027-03-04' };
const week = {
  days: [1, 2, 3, 4].map((day) => ({ day, start: '17:00', end: day === 3 ? '18:00' : '21:00' })),
  basketball: [1, 2, 3, 4].map((day) => ({ day, start: '17:00', court: 'west1' })),
  cheer: [1, 4].map((day) => ({ day, room: 'Room 20' })),
};
const GAME_DAYS = [{ date: '2027-01-15', first: '17:15' }, { date: '2027-01-16', first: '08:00' }, { date: '2027-03-06', first: '08:00' }];

test('importer: practice range = min/max dated practice row (real CSVs: Jan 4 – Mar 4, 2027)', () => {
  const plan = buildSeasonPlan(readSeasonCsvs());
  assert.deepEqual(plan.practiceRange, RANGE);
  assert.match(formatSeasonReport(plan), /Practice dates: 2027-01-04 to 2027-03-04/);
  assert.deepEqual(practiceRangeOf(['2027-02-01', '2027-01-05', '2027-03-01']), { start: '2027-01-05', end: '2027-03-01' });
  assert.throws(() => practiceRangeOf([]), /no dated rows/);
});

test('nextEvent: counts from the shown day; practice only inside the range; nothing after it', { skip: noPub }, async () => {
  const { nextEvent, nextEventText } = await ev();
  const P = { ...week, range: RANGE };
  // The bug: Sat Jan 16 at 20:05 -> Mon Jan 18 (not the real-date Nov 2).
  const sat = nextEvent({ today: '2027-01-16', now: '20:05', gameDays: GAME_DAYS, practice: P });
  assert.deepEqual(sat, { type: 'practice', date: '2027-01-18', time: '17:00' });
  assert.equal(nextEventText(sat, '2027-01-16', true), 'Next: Practice Monday, Jan 18 · 5:00 PM');
  // Before the range: the first practice date, or an earlier game day.
  assert.deepEqual(nextEvent({ today: '2026-10-30', now: '22:00', gameDays: [], practice: P }), { type: 'practice', date: '2027-01-04', time: '17:00' });
  assert.deepEqual(nextEvent({ today: '2026-10-30', now: '22:00', gameDays: GAME_DAYS, practice: P }).date, '2027-01-04');
  assert.deepEqual(nextEvent({ today: '2027-01-02', now: '12:00', gameDays: [{ date: '2027-01-02', first: '13:00' }], practice: P }), { type: 'game', date: '2027-01-02', time: '13:00' });
  // Last practice night: Thu Mar 4 counts until it ends; after that only the Mar 6 games, then nothing (no line).
  assert.deepEqual(nextEvent({ today: '2027-03-04', now: '18:00', practice: P }), { type: 'practice', date: '2027-03-04', time: '17:00', now: true });
  assert.equal(nextEvent({ today: '2027-03-04', now: '21:30', practice: P }), null);
  assert.deepEqual(nextEvent({ today: '2027-03-04', now: '21:30', gameDays: GAME_DAYS, practice: P }), { type: 'game', date: '2027-03-06', time: '08:00' });
  const done = nextEvent({ today: '2027-03-06', now: '20:05', gameDays: GAME_DAYS, practice: P });
  assert.equal(done, null);
  assert.equal(nextEventText(done, '2027-03-06', true), null, 'season over: no next-event line');
  assert.equal(nextEventText(null, '2027-03-06'), 'No games or practices scheduled', 'no range: old text');
  // Kind: cheer is Mon/Thu only -> after Tue Mar 2 the next cheer night is Thu Mar 4; after Thu nothing.
  assert.equal(nextEvent({ today: '2027-03-02', now: '22:00', practice: P, kind: 'cheer' }).date, '2027-03-04');
  assert.equal(nextEvent({ today: '2027-03-05', now: '08:00', practice: P, kind: 'cheer' }), null);
  // No range (demo): weekly forever.
  assert.deepEqual(nextEvent({ today: '2027-03-06', now: '20:05', practice: week }), { type: 'practice', date: '2027-03-08', time: '17:00' });
  assert.deepEqual(nextEvent({ today: '2026-10-30', now: '22:00', practice: week }), { type: 'practice', date: '2026-11-02', time: '17:00' });
});

test('practiceDisplayDay == practiceDisplayOf with a range: before -> Mon Jan 4 preview; after Mar 4 -> over', { skip: noPub }, async () => {
  const { practiceDisplayDay, planPractice } = await pv();
  const P = { ...week, range: RANGE };
  const cases: [string, number, string | null, object][] = [
    ['2026-10-30', 5, null, { date: '2027-01-04', dow: 1, today: false }],
    ['2026-10-30', 5, 'cheer', { date: '2027-01-04', dow: 1, today: false }],
    ['2027-01-02', 6, 'basketball', { date: '2027-01-04', dow: 1, today: false }],
    ['2027-01-04', 1, 'basketball', { date: '2027-01-04', dow: 1, today: true }],
    ['2027-01-16', 6, 'basketball', { date: '2027-01-18', dow: 1, today: false }],
    ['2027-01-16', 6, 'cheer', { date: '2027-01-18', dow: 1, today: false }],
    ['2027-03-04', 4, 'basketball', { date: '2027-03-04', dow: 4, today: true }],
    ['2027-03-03', 3, 'cheer', { date: '2027-03-04', dow: 4, today: false }],
    ['2027-03-05', 5, 'basketball', { date: '2027-03-05', dow: 5, today: true, over: true }],
    ['2027-03-06', 6, null, { date: '2027-03-06', dow: 6, today: true, over: true }],
  ];
  for (const [today, dow, kind, want] of cases) {
    assert.deepEqual(practiceDisplayDay(P, kind, today, dow), want, `js ${today} ${kind}`);
    assert.deepEqual(practiceDisplayOf(P as any, kind as any, today, dow), want, `ts ${today} ${kind}`);
  }
  // No range: unchanged weekly behaviour.
  assert.deepEqual(practiceDisplayDay(week, 'basketball', '2027-03-06', 6), { date: '2027-03-08', dow: 1, today: false });
  assert.deepEqual(practiceDisplayOf(week as any, null, '2026-10-30', 5), { date: '2026-11-02', dow: 1, today: false });
  // 'over' plans idle even on a weekday that has slots.
  const data = { ...P, basketball: P.basketball.map((x) => ({ ...x, team: { name: 'T' } })) };
  assert.equal(planPractice(data, 'basketball', 1, '17:30', 'over').mode, 'idle');
  assert.equal(planPractice(data, 'basketball', 1, '17:30', 'future').mode, 'practice');
});

test('locker rooms: fixed court rule (Cheer 1; West/Full CH-5; East 2-3); a stored locker overrides', () => {
  assert.deepEqual(LOCKER_ROOMS, { cheer: '1', west: { home: 'CH', away: '5' }, east: { home: '2', away: '3' }, full: { home: 'CH', away: '5' } });
  assert.equal(teamLocker('west', 'home'), 'CH'); assert.equal(teamLocker('west', 'away'), '5');
  assert.equal(teamLocker('east', 'home', null), '2'); assert.equal(teamLocker('east', 'away', ''), '3');
  assert.equal(teamLocker('full', 'home'), 'CH'); assert.equal(teamLocker('full', 'away'), '5');
  assert.equal(teamLocker(null, 'home'), null); assert.equal(teamLocker('nope', 'away'), null);
  assert.equal(teamLocker('east', 'home', '7'), '7', 'override wins');
  assert.equal(cheerLocker(null), '1'); assert.equal(cheerLocker(' '), '1'); assert.equal(cheerLocker('4'), '4');
});

// ---------------------------------------------------------------- DB + server + browser
const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test" (it is wiped)' : false;
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
let db: typeof import('../src/db.js');
let srv: ChildProcess | null = null;
let URL_ = '';

before(async () => {
  if (skip) return;
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_prange'; u.pathname = '/' + name; URL_ = u.toString();
  const admin = new pg.Client({ connectionString: BASE_URL }); await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.DATABASE_URL = URL_; process.env.TZ = 'America/Chicago';
  db = await import('../src/db.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
after(async () => { srv?.kill(); await db?.pool.end(); });

test('DB: importer writes practice_start/end; /api/public/practice + lobby/practice screens use them (test clock, ?at=)', { skip, timeout: 240_000 }, async () => {
  const season = await import('../src/seed-season.js');
  await db.migrate();
  const settings = async () => Object.fromEntries((await db.pool.query(`SELECT key, value FROM settings WHERE key IN ('season_data','practice_start','practice_end')`)).rows.map((r) => [r.key, r.value]));
  assert.deepEqual(await settings(), {}, 'no range before the import');
  const dry = await season.seedSeason({ dryRun: true });
  assert.match(dry.report, /Practice dates: 2027-01-04 to 2027-03-04/);
  assert.deepEqual(await settings(), {}, 'dry run writes no range');
  await season.seedSeason({});
  assert.deepEqual(await settings(), { season_data: '2027', practice_start: '2027-01-04', practice_end: '2027-03-04' });

  const run = async (now: string) => {
    srv?.kill();
    const s = await startServer({ DATABASE_URL: URL_, ADMIN_PASSWORD: 'prange-admin', TZ: 'America/Chicago', SEED: '', SCOREBOARD_TEST_CLOCK: '1', SCOREBOARD_TEST_NOW: now });
    srv = s.srv; return `http://127.0.0.1:${s.port}`;
  };
  const getJson = async (u: string) => { const r = await fetch(u); assert.equal(r.status, 200); return r.json() as Promise<any>; };

  // Fri Oct 30, 2026 (before the range): server display = Mon Jan 4.
  let base = await run('2026-10-30T22:00:00-05:00');
  let pr = await getJson(base + '/api/public/practice');
  assert.deepEqual(pr.range, RANGE);
  assert.deepEqual(pr.display, { date: '2027-01-04', dow: 1, today: false });

  // Lockers: the imported season stores none (the CSVs have no locker column); every payload derives them.
  assert.equal(Number((await db.pool.query(`SELECT count(*)::int n FROM games WHERE home_locker IS NOT NULL OR away_locker IS NOT NULL`)).rows[0].n), 0);
  assert.equal(Number((await db.pool.query(`SELECT count(*)::int n FROM cheer_slots WHERE locker IS NOT NULL`)).rows[0].n), 0);
  for (const date of ['2027-01-15', '2027-01-16']) {
    const sc = await getJson(base + '/api/public/schedule?date=' + date);
    assert.ok(sc.games.length > 0);
    for (const g of sc.games) {
      assert.equal(g.home.locker, (LOCKER_ROOMS as any)[g.court].home, `${g.id} ${g.court} home`);
      assert.equal(g.away.locker, (LOCKER_ROOMS as any)[g.court].away, `${g.id} ${g.court} away`);
    }
    assert.ok(sc.cheerSlots.every((c: any) => c.locker === '1'));
    if (date === '2027-01-16') assert.ok(sc.cheerSlots.length > 0, 'Saturday has cheer'); // Friday has none in the CSV
  }
  // A stored per-game locker overrides the rule (then put back).
  const g0 = (await getJson(base + '/api/public/schedule?date=2027-01-16')).games.find((g: any) => g.court === 'east');
  await db.pool.query(`UPDATE games SET home_locker = '9' WHERE id = $1`, [g0.id]);
  assert.equal((await getJson(base + '/api/public/schedule?date=2027-01-16')).games.find((g: any) => g.id === g0.id).home.locker, '9');
  await db.pool.query(`UPDATE games SET home_locker = NULL WHERE id = $1`, [g0.id]);

  const browserOk = fs.existsSync(CHROME);
  let pw: any = null; try { pw = await import('playwright-core' as string); } catch { /* optional */ }
  if (browserOk && pw) {
    const browser = await pw.chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const text = async (url: string, sel: string, want?: RegExp) => {
      await page.goto(url);
      if (want) await page.waitForFunction(([s, w]: [string, string]) => new RegExp(w).test(document.querySelector(s)?.textContent || ''), [sel, want.source], { timeout: 15_000 });
      else await page.waitForSelector(sel, { timeout: 15_000 });
      await page.waitForTimeout(500);
      return ((await page.textContent(sel)) || '').trim();
    };
    // The bug: Jan 16 at 20:05 (real clock Oct 30) said "Next: Practice Monday, Nov 2".
    assert.equal(await text(base + '/lobby?date=2027-01-16&at=20:05', '[data-bind="idle-next"]', /Next:/), 'Next: Practice Monday, Jan 18 · 5:00 PM');
    assert.equal(await text(base + '/lobby?date=2027-01-16&at=20:05', '[data-bind="idle-title"]'), 'No more games');
    // Lobby cards: Sat 8:10 split (West CH/5, East 2/3, cheer 1); Sat 16:40 Full (CH/5); tip-off band keeps lockers.
    const lockers = async (url: string) => {
      await page.goto(url); await page.waitForSelector('[data-row="home"]', { timeout: 15_000 }); await page.waitForTimeout(800);
      return page.$$eval('[data-row]', (rows: any[]) => rows.map((r) => `${r.dataset.row}:${r.querySelector('[data-bind="locker"] b')?.textContent || ''}`).join(' '));
    };
    assert.equal(await lockers(base + '/lobby?date=2027-01-16&at=08:10'), 'home:CH away:5 home:2 away:3 cheer:1 home:CH away:5 home:2 away:3 cheer:1');
    assert.equal(await lockers(base + '/lobby?date=2027-01-16&at=08:20'), 'home:CH away:5 home:2 away:3 cheer:1 home:CH away:5 home:2 away:3 cheer:1', 'tip-off band');
    assert.match(await lockers(base + '/lobby?date=2027-01-16&at=14:10'), /^home:CH away:5( cheer:1)? home:CH away:5/);
    // Mar 6 after the last game: no practice left, no game left -> no line.
    await page.goto(base + '/lobby?date=2027-03-06&at=20:05');
    await page.waitForSelector('[data-bind="idle-title"]', { timeout: 15_000 }); await page.waitForTimeout(1500);
    assert.equal(((await page.textContent('[data-bind="idle-next"]')) || '').trim(), '');
    // Mar 5 (Fri) at 20:05 has games on Mar 6 -> the game line, never a practice.
    await page.goto(base + '/lobby?date=2027-03-05&at=21:30'); await page.waitForTimeout(2500);
    const mar5 = ((await page.textContent('[data-bind="idle-next"]').catch(() => '')) || '').trim();
    assert.ok(!/Practice/.test(mar5), mar5);
    // Practice screen before the range: Monday Jan 4 preview.
    await page.goto(base + '/practice/basketball'); await page.waitForTimeout(2500);
    assert.match(await page.textContent('body'), /Starts Monday 5:00 PM/);
    assert.equal(await page.getAttribute('body', 'data-mode'), 'practice');
    assert.equal(await page.getAttribute('body', 'data-day'), 'mon');

    // Fri Mar 5, 2027 (after the last practice): idle, no next practice (next line is the Mar 6 games).
    base = await run('2027-03-05T18:00:00-06:00');
    pr = await getJson(base + '/api/public/practice');
    assert.equal(pr.display.over, true);
    for (const kind of ['basketball', 'cheer']) {
      await page.goto(base + '/practice/' + kind); await page.waitForTimeout(2500);
      assert.equal(await page.getAttribute('body', 'data-mode'), 'idle', kind);
      const next = ((await page.textContent('[data-bind="next"]').catch(() => '')) || '').trim();
      assert.equal(next, 'Next: Games Saturday, Mar 6 · First tip-off 8:00 AM', kind);
    }
    // Sun Mar 7: nothing left at all -> idle, no next line.
    base = await run('2027-03-07T12:00:00-06:00');
    await page.goto(base + '/practice/basketball'); await page.waitForTimeout(2500);
    assert.equal(await page.getAttribute('body', 'data-mode'), 'idle');
    assert.equal(await page.$('[data-bind="next"]'), null);
    await browser.close();
  }

  // Demo reset clears the range (and the marker): weekly behaviour again.
  srv?.kill(); srv = null;
  await db.seedDemo('reset', Date.parse('2026-10-30T22:00:00-05:00'));
  assert.deepEqual(await settings(), {}, 'demo reset clears season_data + practice range');
  base = await run('2026-10-30T22:00:00-05:00');
  pr = await getJson(base + '/api/public/practice');
  assert.equal(pr.range, null, 'no range -> null');
});
