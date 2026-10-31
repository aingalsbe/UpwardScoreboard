// Next lobby / practice day when the screen has no date or day (America/Chicago).
// Unit tests always run. The DB part needs TEST_DATABASE_URL (own database "<name>_nextday", wiped).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import WebSocket from 'ws';
import { nextEventDay, resolveScheduleDay, scheduleQueryGiven, defaultScheduleDay, localDate } from '../src/schedule.js';
import { practiceDisplayOf } from '../src/practice.js';
import { startServer } from './_server.js';

const TZ = 'America/Chicago';
const FRI_1PM = Date.parse('2026-10-30T18:00:00Z'); // Fri 2026-10-30 13:00 CDT
const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const noPub = !fs.existsSync(path.join(PUB, 'practice-view.js')) && 'public/ not present';
const view = () => import(path.join(PUB, 'practice-view.js'));
const lobbyView = () => import(path.join(PUB, 'lobby-view.js'));

test('nextEventDay: today if it has games, else the next date, else today (unsorted ok)', () => {
  assert.equal(nextEventDay(['2026-10-30', '2026-11-06'], '2026-10-30'), '2026-10-30');
  assert.equal(nextEventDay(['2026-11-06', '2026-10-31', '2026-10-17'], '2026-10-30'), '2026-10-31');
  assert.equal(nextEventDay([], '2026-10-30'), '2026-10-30');
  assert.equal(nextEventDay(['2026-10-17', '2026-10-24'], '2026-10-30'), '2026-10-30', 'past dates are not the default');
  assert.equal(nextEventDay(['2026-11-06', '2026-10-30', '2026-10-31'], '2026-10-30'), '2026-10-30');
});

test('resolveScheduleDay is unchanged for ?date= and ?day=; only a blank query is "not given"', () => {
  assert.equal(resolveScheduleDay({}, FRI_1PM, TZ), '2026-10-30');
  assert.equal(resolveScheduleDay({ day: 'sat' }, Date.parse('2026-10-14T15:00:00Z'), TZ), '2026-10-17');
  assert.equal(resolveScheduleDay({ date: '2026-11-07', day: 'fri' }, 0, TZ), '2026-11-07');
  assert.equal(resolveScheduleDay({ date: '2026-02-31' }, FRI_1PM, TZ), '2026-10-30');
  assert.equal(resolveScheduleDay({ day: 'sun' }, FRI_1PM, TZ), '2026-10-30', 'a weekday that is not fri/sat stays on today');
  assert.equal(scheduleQueryGiven({}), false);
  assert.equal(scheduleQueryGiven({ date: null, day: null }), false);
  assert.equal(scheduleQueryGiven({ date: '', day: '  ' }), false);
  assert.equal(scheduleQueryGiven({ date: '2026-02-31' }), true);
  assert.equal(scheduleQueryGiven({ day: 'fri' }), true);
  assert.equal(scheduleQueryGiven({ day: 'sun' }), true);
});

test('defaultScheduleDay asks once for dates on or after today and picks nextEventDay', async () => {
  let calls = 0;
  const q = {
    query: async (sql: string, params?: unknown[]) => {
      calls++;
      assert.match(sql, /SELECT DISTINCT/);
      assert.match(sql, /scheduled_at >=/);
      assert.deepEqual(params, [TZ, '2026-10-30']);
      return { rows: [{ date: '2026-11-06' }, { date: '2026-10-31' }] };
    },
  };
  assert.equal(await defaultScheduleDay(q, FRI_1PM, TZ), '2026-10-31');
  assert.equal(calls, 1);
  const none = { query: async () => ({ rows: [] as { date: string }[] }) };
  assert.equal(await defaultScheduleDay(none, FRI_1PM, TZ), '2026-10-30');
  assert.equal(localDate(FRI_1PM, TZ), '2026-10-30');
});

test('idle title does not say "today" for a future shown day', { skip: !fs.existsSync(path.join(PUB, 'lobby-view.js')) && 'public/ not present' }, async () => {
  const { idleTitle } = await lobbyView();
  assert.equal(idleTitle(true, '2026-11-06', '2026-10-30'), 'No more games');
  assert.equal(idleTitle(false, '2026-11-06', '2026-10-30'), 'No games scheduled');
  assert.equal(idleTitle(true, '2026-10-30', '2026-10-30'), 'No more games today');
  assert.equal(idleTitle(false, '2026-10-30', '2026-10-30'), 'No games today');
  assert.equal(idleTitle(false, '2026-11-06', null), 'No games today', 'unknown real today keeps the old copy');
});

const week = {
  days: [{ day: 1, start: '17:00', end: '19:00' }, { day: 4, start: '17:00', end: '18:00' }],
  basketball: [{ day: 1, start: '17:00', court: 'west1' }, { day: 1, start: '18:00', court: 'east2' }],
  cheer: [{ day: 4, room: 'Room 20' }],
};

test('practiceDisplayDay / practiceDisplayOf: next weekday with that kind of slots, else today', { skip: noPub }, async () => {
  const { practiceDisplayDay } = await view();
  const fri = '2026-10-30';
  const both = (kind: 'basketball' | 'cheer' | null, today: string, dow: number | string) => {
    const js = practiceDisplayDay(week, kind, today, dow);
    const ts = practiceDisplayOf(week, kind, today, Number(dow));
    assert.deepEqual(js, ts);
    return js;
  };
  assert.deepEqual(both('basketball', '2026-10-26', 1), { date: '2026-10-26', dow: 1, today: true }, 'Monday with slots stays Monday');
  assert.deepEqual(both(null, fri, 5), { date: '2026-11-02', dow: 1, today: false }, 'Friday -> Monday (either kind)');
  assert.deepEqual(both('basketball', fri, '5'), { date: '2026-11-02', dow: 1, today: false }, 'Friday basketball -> Monday');
  assert.deepEqual(both('cheer', fri, 5), { date: '2026-11-05', dow: 4, today: false }, 'Friday cheer -> Thursday');
  // Thursday has slots: the helper does not look at the clock, so the day stays Thursday after the window.
  const thu = { days: [{ day: 4, start: '17:00', end: '18:00' }], basketball: [{ day: 4, start: '17:00', court: 'west1' }], cheer: [{ day: 4, room: 'Room 20' }] };
  assert.deepEqual(practiceDisplayDay(thu, 'basketball', '2026-10-29', 4), { date: '2026-10-29', dow: 4, today: true });
  assert.deepEqual(practiceDisplayOf(thu, 'cheer', '2026-10-29', 4), { date: '2026-10-29', dow: 4, today: true });
  const cheerOnly = { days: [{ day: 4, start: '17:00', end: '18:00' }], basketball: [], cheer: [{ day: 4, room: 'Room 20' }] };
  assert.deepEqual(practiceDisplayDay(cheerOnly, 'cheer', fri, 5), { date: '2026-11-05', dow: 4, today: false });
  assert.deepEqual(practiceDisplayDay(cheerOnly, 'basketball', fri, 5), { date: fri, dow: 5, today: true }, 'no basketball slots -> today');
  const ballOnly = { days: [{ day: 1, start: '17:00', end: '19:00' }], basketball: [{ day: 1, start: '17:00', court: 'west1' }], cheer: [] };
  assert.deepEqual(practiceDisplayDay(ballOnly, 'basketball', fri, 5), { date: '2026-11-02', dow: 1, today: false });
  assert.deepEqual(practiceDisplayDay(ballOnly, 'cheer', fri, 5), { date: fri, dow: 5, today: true }, 'no cheer slots -> today');
  const empty = { days: [], basketball: [], cheer: [] };
  assert.deepEqual(practiceDisplayDay(empty, 'basketball', fri, 5), { date: fri, dow: 5, today: true });
  assert.deepEqual(practiceDisplayOf(empty, null, fri, 5), { date: fri, dow: 5, today: true });
  assert.deepEqual(practiceDisplayOf(cheerOnly, null, fri, 5), { date: '2026-11-05', dow: 4, today: false }, 'server display is either kind');
});

test('planPractice: future preview and today-hold; demo (no mode) stays idle outside the window', { skip: noPub }, async () => {
  const { planPractice, rotation, parsePracticeDemo } = await view();
  const t = (name: string) => ({ name, coach: 'Sam', logo: null });
  const data = {
    days: [{ day: 1, start: '17:00', end: '19:00' }],
    basketball: [{ day: 1, start: '17:00', court: 'west1', team: t('A') }, { day: 1, start: '18:00', court: 'east2', team: t('B') }],
    cheer: [{ day: 1, room: 'Room 20', squad: t('Q') }],
  };
  assert.equal(planPractice(data, 'basketball', 1, '10:00').mode, 'idle');
  assert.equal(planPractice(data, 'basketball', 1, '15:59').mode, 'idle');
  assert.equal(planPractice(data, 'basketball', 1, '19:15').mode, 'idle');
  const future = planPractice(data, 'basketball', 1, '10:00', 'future');
  assert.equal(future.mode, 'practice');
  assert.equal(future.header, 'MONDAY');
  assert.equal(future.startsText, 'Starts Monday 5:00 PM');
  assert.equal(future.current, null);
  assert.deepEqual([0, 11, 12].map((s) => rotation(future, s)).map((r: { index: number; state: string }) => `${r.index}${r.state}`), ['0all', '0all', '1all']);
  const cheer = planPractice(data, 'cheer', 1, '23:00', 'future');
  assert.equal(cheer.mode, 'practice');
  assert.equal(cheer.header, 'MONDAY CHEER');
  assert.equal(cheer.startsText, 'Starts Monday 5:00 PM');
  assert.equal(cheer.current, null);
  const holdBefore = planPractice(data, 'basketball', 1, '15:59', 'hold');
  assert.equal(holdBefore.mode, 'practice');
  assert.equal(holdBefore.startsText, 'Starts 5:00 PM');
  assert.equal(holdBefore.current, null);
  assert.equal(holdBefore.header, 'MONDAY');
  const holdAfter = planPractice(data, 'basketball', 1, '19:15', 'hold');
  assert.equal(holdAfter.mode, 'practice');
  assert.equal(holdAfter.current, 1, 'last slot stays up');
  assert.equal(holdAfter.startsText, null);
  assert.equal(rotation(holdAfter, 30).state, 'current');
  const cheerAfter = planPractice(data, 'cheer', 1, '19:15', 'hold');
  assert.equal(cheerAfter.mode, 'practice');
  assert.equal(cheerAfter.current, null);
  assert.deepEqual(parsePracticeDemo(new URLSearchParams('at=17:00')), { dow: null, hm: '17:00' }, '?at= alone keeps today');
});

// ---------------------------------------------------------------- DB + server
const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test" (it is wiped)' : false;
let db: typeof import('../src/db.js');
let srv: ChildProcess | null = null;
let URL_ = '';
let PORT = 0, BASE = '';
const ADMIN = 'nextday-admin-pw';
const sockets: WebSocket[] = [];

before(async () => {
  if (skip) return;
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_nextday'; u.pathname = '/' + name; URL_ = u.toString();
  const admin = new pg.Client({ connectionString: BASE_URL }); await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.DATABASE_URL = URL_; process.env.TZ = TZ;
  db = await import('../src/db.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
after(async () => {
  for (const ws of sockets) ws.close();
  srv?.kill();
  await db?.pool.end();
});

test('DB: no-param schedule is the next game day; practice display follows slots; auto lobby rolls only at midnight', { skip, timeout: 150_000 }, async () => {
  const { pool } = db;
  await db.migrate();
  await pool.query(`INSERT INTO courts(slug, name, conflicts_with) VALUES ('full','Full','{west,east}'),('west','West','{}'),('east','East','{}')`);
  const team = async (n: string) => (await pool.query(
    `INSERT INTO teams(name, short_name, grade, grade_order, gender) VALUES ($1, upper($1), '3rd Grade', 3, 'Boys') RETURNING id`, [n])).rows[0].id as number;
  const home = await team('Bears'), away = await team('Dolphins');
  const court = (await pool.query(`SELECT id FROM courts WHERE slug='full'`)).rows[0].id as number;
  const addGame = (at: string, status = 'scheduled') => pool.query(
    `INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, status) VALUES ($1,$2,$3,$4::timestamptz,$5) RETURNING id`,
    [court, home, away, at, status]).then((r) => r.rows[0].id as number);

  const clock = '2026-10-30T13:00:00-05:00'; // Friday 1:00 PM CT
  const started = await startServer({
    DATABASE_URL: URL_, ADMIN_PASSWORD: ADMIN, TZ, SEED: '',
    SCOREBOARD_TEST_CLOCK: '1', SCOREBOARD_TEST_NOW: clock,
  });
  srv = started.srv; PORT = started.port; BASE = `http://127.0.0.1:${PORT}`;
  const log = started.log;

  const sched = async (q = '') => {
    const r = await fetch(BASE + '/api/public/schedule' + q);
    const text = await r.text();
    assert.equal(r.status, 200, `${q || '(no param)'} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  const practice = async () => {
    const r = await fetch(BASE + '/api/public/practice');
    const text = await r.text();
    assert.equal(r.status, 200, text.slice(0, 300));
    return JSON.parse(text);
  };

  // Empty database: today, not a 500, and the pages themselves still serve.
  assert.equal((await sched()).date, '2026-10-30');
  const emptyP = await practice();
  assert.deepEqual(emptyP.display, { date: '2026-10-30', dow: 5, today: true });
  assert.equal(emptyP.now.date, '2026-10-30');
  assert.deepEqual(emptyP.basketball, []); assert.deepEqual(emptyP.cheer, []);
  for (const u of ['/lobby', '/lobby/', '/upwardbasketballscores/lobby', '/upwardbasketballscores/lobby/', '/practice/cheer', '/practice/basketball', '/upwardbasketballscores/practice/cheer', '/upwardbasketballscores/practice/basketball']) {
    const r = await fetch(BASE + u); assert.equal(r.status, 200, u);
  }

  await addGame('2026-11-06T18:00:00-06:00'); // later Friday
  await addGame('2026-10-31T09:00:00-05:00'); // this Saturday, unsorted relative to the insert above
  const next = await sched();
  assert.equal(next.date, '2026-10-31', 'smallest future date, not the later Friday');
  assert.ok(next.games.length >= 1 && next.games.every((g: { status: string }) => g.status === 'scheduled'), 'a future day is upcoming, nothing live');
  assert.equal((await sched('?day=sat')).date, '2026-10-31');
  assert.equal((await sched('?date=2026-11-06')).date, '2026-11-06');
  assert.equal((await sched('?date=2026-02-31')).date, '2026-10-30', 'invalid date still falls back to today, not the next game day');
  assert.equal((await sched('?day=sun')).date, '2026-10-30');

  const todayId = await addGame('2026-10-30T09:00:00-05:00');
  const todaySnap = await sched();
  assert.equal(todaySnap.date, '2026-10-30', 'today wins while it has a game');
  assert.ok(todaySnap.games.some((g: { id: number }) => g.id === todayId), 'the snapshot is that day, not the next one');
  await pool.query(`UPDATE games SET status='complete', final_home=10, final_away=8 WHERE id=$1`, [todayId]);
  assert.equal((await sched()).date, '2026-10-30', 'still today after the last game is final');
  await pool.query(`DELETE FROM games WHERE id=$1`, [todayId]);
  assert.equal((await sched()).date, '2026-10-31');
  await pool.query(`DELETE FROM games WHERE (scheduled_at AT TIME ZONE 'America/Chicago')::date = '2026-10-31'`);
  assert.equal((await sched()).date, '2026-11-06');

  // An auto lobby moves when a game is added on an earlier day. An explicit date or day does not.
  const open = (qs: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${qs}`);
    sockets.push(ws);
    const states: { date: string; serverNow: number; games: { status: string }[] }[] = [];
    const times: number[] = [];
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no schedule state for ${qs}`)), 8000);
      ws.on('message', (m) => {
        const j = JSON.parse(String(m));
        if (j.type === 'state' && j.kind === 'schedule') { states.push(j); if (states.length === 1) { clearTimeout(t); resolve(); } }
        else if (j.type === 'time') times.push(j.serverNow);
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });
    return { ws, states, times, ready };
  };
  const until = async (pred: () => boolean, ms: number, label: string) => {
    const start = Date.now();
    while (Date.now() - start < ms) { if (pred()) return; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error('timeout: ' + label);
  };
  const auto = open('court=*&role=schedule');
  const pinned = open('court=*&role=schedule&date=2026-11-06');
  const friday = open('court=*&role=schedule&day=fri');
  await Promise.all([auto.ready, pinned.ready, friday.ready]);
  assert.equal(auto.states[0].date, '2026-11-06');
  assert.equal(pinned.states[0].date, '2026-11-06');
  assert.equal(friday.states[0].date, '2026-10-30');
  const token = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) })).json()).token as string;
  const posted = await fetch(BASE + '/api/games', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ home_team_id: home, away_team_id: away, court_id: court, scheduled_at: '2026-10-31T09:00:00-05:00' }),
  });
  assert.equal(posted.status, 201, await posted.clone().text());
  await until(() => auto.states.some((s) => s.date === '2026-10-31'), 5000, 'auto lobby moves to the earlier day');
  assert.ok(auto.states.every((s) => s.date === '2026-11-06' || s.date === '2026-10-31'));
  pinned.ws.send(JSON.stringify({ type: 'resync' }));
  friday.ws.send(JSON.stringify({ type: 'resync' }));
  await until(() => pinned.states.length >= 2 && friday.states.length >= 2, 5000, 'explicit resync');
  assert.ok(pinned.states.every((s) => s.date === '2026-11-06'), 'explicit ?date= never moves');
  assert.ok(friday.states.every((s) => s.date === '2026-10-30'), 'explicit ?day= never moves');
  for (const s of sockets) s.close();
  sockets.length = 0;

  await pool.query(`DELETE FROM games WHERE scheduled_at >= ($1::date::timestamp AT TIME ZONE 'America/Chicago')`, ['2026-10-30']);
  await addGame('2026-10-24T09:00:00-05:00', 'complete');
  assert.equal((await sched()).date, '2026-10-30', 'no future games: today, not the past final');

  // Practice: both kinds, then one kind, then none. No 5xx.
  const { practiceDisplayDay } = await view();
  const squad = (await pool.query(`INSERT INTO cheer_squads(name) VALUES ('Hype') RETURNING id`)).rows[0].id as number;
  await pool.query(`INSERT INTO practice_days(day_of_week, start_time, end_time) VALUES (1, '17:00', '19:00'), (4, '17:00', '18:00')`);
  await pool.query(`INSERT INTO practice_slots(day_of_week, kind, start_time, court, team_id) VALUES (1, 'basketball', '17:00', 'west1', $1)`, [home]);
  await pool.query(`INSERT INTO practice_slots(day_of_week, kind, room, squad_id) VALUES (4, 'cheer', 'Room 20', $1)`, [squad]);
  const both = await practice();
  assert.deepEqual(both.display, { date: '2026-11-02', dow: 1, today: false });
  assert.deepEqual(practiceDisplayDay(both, 'basketball', both.now.date, both.now.dow), { date: '2026-11-02', dow: 1, today: false });
  assert.deepEqual(practiceDisplayDay(both, 'cheer', both.now.date, both.now.dow), { date: '2026-11-05', dow: 4, today: false });
  await pool.query(`DELETE FROM practice_slots WHERE kind='basketball'`);
  await pool.query(`DELETE FROM practice_days WHERE day_of_week=1`);
  const cheerOnly = await practice();
  assert.equal(cheerOnly.basketball.length, 0); assert.ok(cheerOnly.cheer.length >= 1);
  assert.deepEqual(cheerOnly.display, { date: '2026-11-05', dow: 4, today: false });
  assert.deepEqual(practiceDisplayDay(cheerOnly, 'basketball', cheerOnly.now.date, cheerOnly.now.dow), { date: '2026-10-30', dow: 5, today: true });
  assert.deepEqual(practiceDisplayDay(cheerOnly, 'cheer', cheerOnly.now.date, cheerOnly.now.dow), { date: '2026-11-05', dow: 4, today: false });
  await pool.query(`DELETE FROM practice_slots`);
  await pool.query(`DELETE FROM practice_days`);
  await pool.query(`INSERT INTO practice_days(day_of_week, start_time, end_time) VALUES (1, '17:00', '19:00')`);
  await pool.query(`INSERT INTO practice_slots(day_of_week, kind, start_time, court, team_id) VALUES (1, 'basketball', '17:00', 'west1', $1)`, [home]);
  const ballOnly = await practice();
  assert.equal(ballOnly.cheer.length, 0);
  assert.deepEqual(ballOnly.display, { date: '2026-11-02', dow: 1, today: false });
  assert.deepEqual(practiceDisplayDay(ballOnly, 'cheer', ballOnly.now.date, ballOnly.now.dow), { date: '2026-10-30', dow: 5, today: true });
  await pool.query(`DELETE FROM practice_slots`);
  await pool.query(`DELETE FROM practice_days`);
  const none = await practice();
  assert.deepEqual(none.display, { date: '2026-10-30', dow: 5, today: true });
  assert.doesNotMatch(log(), /TypeError|UnhandledPromise|unhandled/i);

  // Midnight CT: the auto client keeps Jan 15 (which has a final) until the league date changes, then jumps to Jan 22.
  srv.kill(); srv = null;
  await pool.query('DELETE FROM games');
  await addGame('2027-01-15T18:00:00-06:00', 'complete');
  await addGame('2027-01-22T18:00:00-06:00');
  const MIDNIGHT = Date.parse('2027-01-16T06:00:00.000Z'); // 2027-01-16 00:00 CST
  const night = await startServer({
    DATABASE_URL: URL_, ADMIN_PASSWORD: ADMIN, TZ, SEED: '',
    SCOREBOARD_TEST_CLOCK: '1', SCOREBOARD_TEST_NOW: '2027-01-16T05:59:15.000Z', // 45s before midnight
  }, 20_000);
  srv = night.srv; PORT = night.port; BASE = `http://127.0.0.1:${PORT}`;
  const auto2 = open('court=*&role=schedule');
  const stay = open('court=*&role=schedule&date=2027-01-15');
  const satTv = open('court=*&role=schedule&date=2027-01-16'); // R26-1: a TV already on Saturday, open across midnight
  await Promise.all([auto2.ready, stay.ready, satTv.ready]);
  const { headerText } = await lobbyView();
  const hdr = (st: any) => headerText(st.date, '08:00', st.today || null);
  assert.equal((satTv.states[0] as any).today, '2027-01-15', 'snapshot carries the league date (test clock)');
  assert.equal(hdr(satTv.states[0]), 'SAT JAN 16 \u00b7 8:00 AM', 'before midnight Saturday is another day');
  assert.equal(auto2.states[0].date, '2027-01-15');
  assert.ok(auto2.states[0].serverNow < MIDNIGHT, `test-clock lead too short (serverNow ${new Date(auto2.states[0].serverNow).toISOString()})`);
  auto2.ws.send(JSON.stringify({ type: 'resync' }));
  await until(() => auto2.states.length >= 2, 5000, 'resync before midnight');
  assert.ok(auto2.states.every((s) => s.date === '2027-01-15'), 'before midnight the auto lobby stays on the game day');
  await until(() => auto2.states.some((s) => s.date === '2027-01-22'), 70_000, 'auto lobby rolls after midnight');
  assert.ok(auto2.states.every((s) => s.date === '2027-01-15' || (s.date === '2027-01-22' && s.serverNow >= MIDNIGHT)));
  assert.ok(auto2.states.filter((s) => s.serverNow < MIDNIGHT).every((s) => s.date === '2027-01-15'));
  stay.ws.send(JSON.stringify({ type: 'resync' }));
  await until(() => stay.states.length >= 2, 5000, 'explicit resync after midnight');
  assert.ok(stay.states.every((s) => s.date === '2027-01-15'), 'explicit date stays after midnight');
  // R26-1: with no schedule change, every screen still gets a snapshot with the new league date after midnight.
  await until(() => satTv.states.some((s: any) => s.today === '2027-01-16'), 10_000, 'Saturday TV hears the new league date');
  const after = satTv.states.find((s: any) => s.today === '2027-01-16')!;
  assert.equal(after.date, '2027-01-16');
  assert.equal(hdr(after), 'SATURDAY 8:00 AM', 'own game day after midnight: undated header');
  assert.ok(auto2.states.some((s: any) => s.date === '2027-01-22' && s.today === '2027-01-16'));
  for (const s of sockets) s.close();
  sockets.length = 0;
  assert.doesNotMatch(night.log(), /TypeError|UnhandledPromise|unhandled/i);
});
