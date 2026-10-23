// 2026-10 rules: 6 periods (3 per half, halftime after P3) and no public score for 2nd Grade and below.
// Unit tests always run; the DB/server part needs TEST_DATABASE_URL (database name containing "test"). It uses its own
// database "<name>_sixp" (created if missing, wiped) so it never races db-cheer.test.ts on the shared test database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import WebSocket from 'ws';
import { initialState, apply, periodLabel, DEFAULT_RULES, timeoutCap, isBonus } from '../src/game.js';
import { hidesScore, publicView, scorekeeperView, leaksHiddenScore } from '../src/payload.js';
import { gradeOrder } from '../src/schedule.js';

const T0 = 1_000_000;

test('default rules: 6 periods, two halves of 3, 2 timeouts per half', () => {
  assert.equal(DEFAULT_RULES.periods, 6);
  const s = initialState();
  assert.equal(s.rules.periods, 6); assert.equal(timeoutCap(s.rules), 2); assert.equal(s.home.timeoutsLeft, 2);
  assert.equal(timeoutCap({ ...s.rules, timeoutsPerHalf: undefined, timeoutsPerGame: 3 }), 3, 'legacy games keep per-game timeouts');
});

test('one label scheme: "1st Half · P2", "2nd Half · P5", OT', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((p) => periodLabel(p, 6)),
    ['1st Half · P1', '1st Half · P2', '1st Half · P3', '2nd Half · P4', '2nd Half · P5', '2nd Half · P6', 'OT', 'OT2']);
});

test('period rollover: halftime after P3, fouls + timeouts reset for the 2nd half only', () => {
  let s = initialState({ periodLengthMs: 60_000 });
  for (let i = 0; i < 7; i++) s = apply(s, { type: 'FOUL', team: 'away', delta: 1 }, T0);
  s = apply(s, { type: 'TIMEOUT', team: 'home', delta: -1 }, T0);
  s = apply(s, { type: 'PERIOD', delta: 1 }, T0); s = apply(s, { type: 'PERIOD', delta: 1 }, T0); // P3, same half
  assert.equal(s.period, 3); assert.equal(s.away.fouls, 7); assert.equal(isBonus(s, 'home'), true); assert.equal(s.home.timeoutsLeft, 1);
  assert.equal(s.banner, null);
  // clock runs out at the end of P3 -> HALFTIME on the TV
  s = apply(s, { type: 'CLOCK_START' }, T0); s = apply(s, { type: 'CLOCK_EXPIRE' }, T0 + 61_000);
  assert.equal(s.banner, 'HALFTIME');
  s = apply(s, { type: 'PERIOD', delta: 1 }, T0 + 62_000); // -> P4, 2nd half
  assert.equal(s.period, 4); assert.equal(periodLabel(s.period, 6), '2nd Half · P4');
  assert.equal(s.away.fouls, 0); assert.equal(isBonus(s, 'home'), false, 'bonus is per half');
  assert.equal(s.home.timeoutsLeft, 2); assert.equal(s.away.timeoutsLeft, 2, 'timeouts refill at halftime');
  assert.equal(s.banner, 'HALFTIME');
  s = apply(s, { type: 'CLOCK_START' }, T0 + 70_000); assert.equal(s.banner, null, 'banner clears when the 2nd half starts');
});

test('accidental Next into the 2nd half: Prev restores fouls, timeouts, clock', () => {
  let s = initialState({ periodLengthMs: 60_000 });
  s = apply(s, { type: 'PERIOD', delta: 1 }, T0); s = apply(s, { type: 'PERIOD', delta: 1 }, T0);
  for (let i = 0; i < 5; i++) s = apply(s, { type: 'FOUL', team: 'home', delta: 1 }, T0);
  s = apply(s, { type: 'TIMEOUT', team: 'away', delta: -1 }, T0);
  s = apply(s, { type: 'CLOCK_SET', ms: 9_000 }, T0);
  s = apply(s, { type: 'PERIOD', delta: 1 }, T0);
  assert.equal(s.home.fouls, 0); assert.equal(s.away.timeoutsLeft, 2);
  s = apply(s, { type: 'PERIOD', delta: -1 }, T0);
  assert.equal(s.period, 3); assert.equal(s.home.fouls, 5); assert.equal(s.away.timeoutsLeft, 1); assert.equal(s.clock.remainingMs, 9_000); assert.equal(s.banner, null);
});

test('overtime continues the 2nd half: no foul or timeout reset', () => {
  let s = initialState();
  for (let i = 0; i < 5; i++) s = apply(s, { type: 'PERIOD', delta: 1 }, T0); // P6
  s = apply(s, { type: 'FOUL', team: 'home', delta: 1 }, T0); s = apply(s, { type: 'TIMEOUT', team: 'home', delta: -1 }, T0);
  s = apply(s, { type: 'PERIOD', delta: 1 }, T0);
  assert.equal(s.period, 7); assert.equal(periodLabel(s.period, 6), 'OT');
  assert.equal(s.home.fouls, 1); assert.equal(s.home.timeoutsLeft, 1); assert.equal(s.banner, null);
});

test('score hiding by grade: K, 1st, 2nd hidden; 3rd and up / unknown shown', () => {
  for (const g of ['Kindergarten', '1st Grade', '2nd Grade']) assert.equal(hidesScore(gradeOrder(g)), true, g);
  for (const g of ['3rd Grade', '6th Grade', 'Varsity', null]) assert.equal(hidesScore(gradeOrder(g)), false, String(g));
});

test('publicView strips scores of hidden games (court + lobby payloads); scorekeeper keeps them', () => {
  const st = initialState(); st.home.score = 12; st.away.score = 9;
  const court = { type: 'state', game: { hideScore: true, home: { name: 'Bears' }, away: { name: 'Dolphins' }, state: st },
    lastFinal: { hideScore: true, final_home: 20, final_away: 18 }, today: [{ hideScore: true, final_home: 1, final_away: 2 }, { hideScore: false, final_home: 3, final_away: 4 }] };
  assert.equal(leaksHiddenScore(court), true);
  const pub = publicView(court);
  assert.equal(leaksHiddenScore(pub), false);
  assert.equal(pub.game.state.home.score, null); assert.equal(pub.game.state.period, 1); assert.deepEqual(pub.game.state.clock, st.clock);
  assert.equal(pub.today[1].final_home, 3, 'older grades untouched');
  assert.equal(st.home.score, 12, 'source object not mutated');
  assert.equal(scorekeeperView(court).game.state.home.score, 12);
  const lobby = { type: 'state', kind: 'schedule', games: [{ hideScore: true, period: 2, home: { score: 4 }, away: { score: 2 } }, { hideScore: false, home: { score: 7 }, away: { score: 1 } }] };
  const pl = publicView(lobby);
  assert.equal(leaksHiddenScore(pl), false); assert.equal(pl.games[0].period, 2); assert.equal(pl.games[1].home.score, 7);
});

// ---------------------------------------------------------------- DB + server
const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test" (it is wiped)' : false;
let URL_ = '';
let db: typeof import('../src/db.js'); let srv: ChildProcess | null = null;
const PORT = 33000 + Math.floor(Math.random() * 2000), BASE = `http://127.0.0.1:${PORT}`, ADMIN = 'test-admin-pw';

before(async () => {
  if (skip) return;
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_sixp'; u.pathname = '/' + name; URL_ = u.toString();
  const admin = new pg.Client({ connectionString: BASE_URL }); await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.DATABASE_URL = URL_; process.env.TZ = 'America/Chicago';
  db = await import('../src/db.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
after(async () => { srv?.kill(); await db?.pool.end(); });

test('migration: scheduled games -> 6 periods; finals + active untouched; runs once', { skip }, async () => {
  const { pool } = db;
  await pool.query(db.SCHEMA);
  await pool.query(`INSERT INTO courts(slug, name, conflicts_with) VALUES ('full','Full','{west,east}'),('west','West','{}'),('east','East','{}')`);
  const team = async (n: string, g: string) => (await pool.query(`INSERT INTO teams(name, short_name, grade, grade_order) VALUES ($1,upper($1),$2,$3) RETURNING id`, [n, g, gradeOrder(g)])).rows[0].id;
  const b = await team('Bears', '2nd Grade'), d = await team('Dolphins', '2nd Grade'), h = await team('Hawks', '3rd Grade'), t = await team('Tigers', '3rd Grade');
  const old = { ...initialState({ periods: 4, timeoutsPerGame: 3, timeoutsPerHalf: 0 }) };
  const hist = (st: any) => JSON.stringify({ present: st, past: [], future: [] });
  const fin = { ...old, status: 'complete', home: { ...old.home, score: 20 }, away: { ...old.away, score: 18 } };
  const ins = (h1: number, a1: number, at: string, status: string, history: string | null, rules = '{}', fh: number | null = null, fa: number | null = null) => pool.query(
    `INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, status, history, rules, final_home, final_away) VALUES ((SELECT id FROM courts WHERE slug='west'),$1,$2,$3::timestamptz,$4,$5,$6,$7,$8) RETURNING id`,
    [h1, a1, at, status, history, rules, fh, fa]).then((r) => r.rows[0].id);
  const sched = await ins(b, d, '2026-10-24 09:00-05', 'scheduled', null, '{"periods":4}');
  const schedHist = await ins(h, t, '2026-10-24 10:00-05', 'scheduled', hist(old));
  const final = await ins(h, t, '2026-10-17 10:00-05', 'complete', hist(fin), '{"periods":4}', 20, 18);
  const before = (await pool.query('SELECT rules, history, final_home, final_away, updated_at FROM games WHERE id=$1', [final])).rows[0];
  assert.equal(await db.migrateSixPeriods(), 2);
  const g = async (id: number) => (await pool.query('SELECT rules, history FROM games WHERE id=$1', [id])).rows[0];
  assert.equal((await g(sched)).rules.periods, 6);
  const sh = (await g(schedHist)).history.present;
  assert.equal(sh.rules.periods, 6); assert.equal(sh.rules.timeoutsPerHalf, 2); assert.equal(sh.home.timeoutsLeft, 2);
  assert.deepEqual((await pool.query('SELECT rules, history, final_home, final_away, updated_at FROM games WHERE id=$1', [final])).rows[0], before, 'final untouched');
  assert.equal(await db.migrateSixPeriods(), -1, 'runs once');
  await db.migrate(); // full startup path is a no-op now
  assert.equal((await g(schedHist)).history.present.rules.periods, 6);
});

test('server: 2nd Grade game hides score on tv/overlay/viewer/lobby + public HTTP; scorekeeper sees it', { skip }, async () => {
  const { pool } = db;
  const ids = (await pool.query(`SELECT id, scheduled_at FROM games WHERE status='scheduled' ORDER BY scheduled_at`)).rows;
  const young = ids[0].id, older = ids[1].id;
  // Make the 2nd Grade game live on West with a score, and the 3rd Grade one live on East.
  for (const [id, court, hs, as] of [[young, 'west', 12, 9], [older, 'east', 30, 28]] as const) {
    const st = initialState(); st.status = 'active'; st.home.score = hs; st.away.score = as; st.period = 4;
    await pool.query(`UPDATE games SET status='active', court_id=(SELECT id FROM courts WHERE slug=$2), history=$3 WHERE id=$1`, [id, court, JSON.stringify({ present: st, past: [], future: [] })]);
    await pool.query(`UPDATE courts SET current_game_id=$1 WHERE slug=$2`, [id, court]);
  }
  srv = spawn(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server.js')], {
    env: { ...process.env, DATABASE_URL: URL_, PORT: String(PORT), ADMIN_PASSWORD: ADMIN, TZ: 'America/Chicago', SEED: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; srv.stdout!.on('data', (x) => (log += x)); srv.stderr!.on('data', (x) => (log += x));
  for (let i = 0; i < 100 && !/listening/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(log, /listening/, log);
  const token = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) })).json()).token;

  const west = await (await fetch(BASE + '/api/public/court/west')).json();
  assert.equal(west.game.hideScore, true); assert.equal(west.game.state.home.score, null); assert.equal(west.game.state.period, 4);
  assert.equal(leaksHiddenScore(west), false);
  const east = await (await fetch(BASE + '/api/public/court/east')).json();
  assert.equal(east.game.hideScore, false); assert.equal(east.game.state.home.score, 30);
  const lobby = await (await fetch(BASE + '/api/public/schedule?date=2026-10-24')).json();
  assert.equal(leaksHiddenScore(lobby), false);
  assert.equal(lobby.games.find((x: any) => x.id === young).period, 4);
  assert.equal(lobby.games.find((x: any) => x.id === older).home.score, 30);

  const first = (q: string, headers: Record<string, string> = {}) => new Promise<any>((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${q}`, { headers });
    ws.on('message', (m) => { const j = JSON.parse(String(m)); if (j.type === 'state') { ws.close(); res(j); } }); ws.on('error', rej);
  });
  for (const role of ['tv', 'overlay', 'viewer']) {
    const m = await first(`court=west&role=${role}`);
    assert.equal(m.game.state.home.score, null, role); assert.equal(leaksHiddenScore(m), false, role);
  }
  const sched = await first('role=schedule&date=2026-10-24');
  assert.equal(leaksHiddenScore(sched), false);
  const sk = await first('court=west&role=score', { authorization: `Bearer ${token}` });
  assert.equal(sk.game.state.home.score, 12, 'scorekeeper still records the score');
});
