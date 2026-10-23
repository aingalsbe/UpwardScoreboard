// Reschedule a game (docs/plans/reschedule-games.md, approved 2026-10-23): POST /api/games/:id/reschedule.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startServer } from './_server.js';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const noPub = !fs.existsSync(path.join(PUB, 'lobby-view.js')) && 'public/ not present';
const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test"' : false;
let db: typeof import('../src/db.js'); let srv: ChildProcess | null = null; let URL_ = '';
let PORT = 0, BASE = ''; // PORT=0: the OS picks a free port (test/_server.ts)
const ADMIN = 'resched-admin-pw';

test('lobby note: "Moved from Sat 11/7 9:00 AM" (date changed) / "Moved from 9:00 AM" (same day) until final', { skip: noPub }, async () => {
  const { movedText } = await import(path.join(PUB, 'lobby-view.js'));
  const g = { status: 'scheduled', movedFrom: { date: '2026-11-07', day: 'Sat', time: '09:00' } };
  assert.equal(movedText(g), 'Moved from Sat 11/7 9:00 AM');
  assert.equal(movedText({ ...g, status: 'active' }), 'Moved from Sat 11/7 9:00 AM');
  assert.equal(movedText({ status: 'scheduled', movedFrom: { ...g.movedFrom, sameDay: true } }), 'Moved from 9:00 AM');
  assert.equal(movedText({ ...g, status: 'complete' }), null);
  assert.equal(movedText({ status: 'scheduled' }), null);
  const lobby = fs.readFileSync(path.join(PUB, 'lobby.js'), 'utf8'); assert.match(lobby, /movedText\(g\)/);
  for (const f of ['tv.js', 'overlay.js', 'score.js']) if (fs.existsSync(path.join(PUB, f))) assert.doesNotMatch(fs.readFileSync(path.join(PUB, f), 'utf8'), /movedFrom|moved_from/, f);
  const admin = fs.readFileSync(path.join(PUB, 'admin.js'), 'utf8');
  assert.match(admin, /f\.time\.value = g\.scheduled_at \? leagueHM\(g\.scheduled_at\)/, 'dialog time pre-fills with the current tip-off');
  assert.doesNotMatch(fs.readFileSync(path.join(PUB, 'admin.html'), 'utf8').match(/<dialog id="resched-dlg"[\s\S]*?<\/dialog>/)![0], /court/i, 'no court picker');
});

before(async () => {
  if (skip) return;
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_reschedule'; u.pathname = '/' + name; URL_ = u.toString();
  const admin = new pg.Client({ connectionString: BASE_URL }); await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.DATABASE_URL = URL_; process.env.TZ = 'America/Chicago';
  db = await import('../src/db.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
after(async () => { srv?.kill(); await db?.pool.end(); });

test('DB: reschedule rules, audit, lobby note, CSV round-trip, plain PUT checks', { skip }, async () => {
  const { pool } = db;
  await db.migrate(); await db.migrate(); // additive + idempotent
  for (const [slug, nm, conf] of [['west', 'West', '{full}'], ['east', 'East', '{full}'], ['full', 'Full', '{west,east}']])
    await pool.query(`INSERT INTO courts(slug, name, conflicts_with) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET conflicts_with=EXCLUDED.conflicts_with`, [slug, nm, conf]);
  const court = async (s: string) => (await pool.query('SELECT id FROM courts WHERE slug=$1', [s])).rows[0].id;
  const T: Record<string, number> = {};
  for (const n of 'ABCDEFGHIJKL') T[n] = (await pool.query(`INSERT INTO teams(name, grade, grade_order, gender) VALUES ($1,'5th Grade',5,'Boys') RETURNING id`, ['T' + n])).rows[0].id;
  const game = async (c: string, at: string, h: string, a: string, extra = '') => (await pool.query(
    `INSERT INTO games(court_id, scheduled_at, home_team_id, away_team_id, home_locker, away_locker${extra ? ', status' : ''}) VALUES ($1, ($2::timestamp AT TIME ZONE 'America/Chicago'), $3, $4, $5, $6${extra ? ', $7' : ''}) RETURNING id`,
    [await court(c), at, T[h], T[a], h === 'A' ? '4' : null, h === 'A' ? 'CH' : null, ...(extra ? [extra] : [])])).rows[0].id;
  const g1 = await game('west', '2026-11-07 09:00', 'A', 'B');
  await game('west', '2026-11-07 10:00', 'C', 'D');
  await game('full', '2026-11-07 12:00', 'E', 'F');
  const g4 = await game('east', '2026-11-07 13:00', 'A', 'G');
  const live = await game('east', '2026-11-06 18:00', 'H', 'I', 'active');
  const fin = await game('east', '2026-11-06 17:00', 'J', 'K', 'complete');
  for (const [s, nm] of [['09:00', 'Pep'], ['14:00', 'Spirit']]) {
    const q = (await pool.query(`INSERT INTO cheer_squads(name) VALUES ($1) RETURNING id`, [nm])).rows[0].id;
    await pool.query(`INSERT INTO cheer_slots(date, slot_start, squad_id) VALUES ('2026-11-07', $1, $2)`, [s, q]);
  }

  const started = await startServer({ DATABASE_URL: URL_, ADMIN_PASSWORD: ADMIN, TZ: 'America/Chicago', SEED: '' });
  srv = started.srv; PORT = started.port; BASE = `http://127.0.0.1:${PORT}`;
  const log = started.log();
  assert.equal((await fetch(`${BASE}/api/games/${g1}/reschedule`, { method: 'POST', body: '{}' })).status, 401, 'admin only');
  const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
  const h = { cookie: (login.headers.get('set-cookie') || '').split(';')[0], 'content-type': 'application/json' };
  const rs = async (id: number, body: any) => { const r = await fetch(`${BASE}/api/games/${id}/reschedule`, { method: 'POST', headers: h, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const row = async (id: number) => (await pool.query(`SELECT court_id, home_locker, away_locker, to_char(scheduled_at AT TIME ZONE 'America/Chicago','YYYY-MM-DD HH24:MI') AS at,
    to_char(moved_from AT TIME ZONE 'America/Chicago','YYYY-MM-DD HH24:MI') AS mf FROM games WHERE id=$1`, [id])).rows[0];
  const changes = async () => (await pool.query('SELECT count(*)::int n FROM game_changes')).rows[0].n;
  const orig = await row(g1);

  // dry run: preview with both hours' cheer, nothing written
  const dry = await rs(g1, { date: '2026-11-07', time: '14:00', dryRun: true });
  assert.equal(dry.status, 200); assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.preview.from.cheer, 'Pep'); assert.equal(dry.body.preview.to.cheer, 'Spirit');
  assert.deepEqual(await row(g1), orig); assert.equal(await changes(), 0, 'dry run writes nothing');

  // Fri/Sat only (league date), conflicts, status
  for (const d of ['2026-11-09', '2026-11-05', '2026-11-08']) {
    const r = await rs(g1, { date: d, time: '09:00' }); assert.equal(r.status, 409, d); assert.match(r.body.errors.join(' '), /Friday or Saturday/);
  }
  const floor = await rs(g1, { date: '2026-11-07', time: '12:00' }); assert.equal(floor.status, 409); assert.match(floor.body.error, /share the floor/);
  const same = await rs(g1, { date: '2026-11-07', time: '10:30' }); assert.equal(same.status, 409); assert.match(same.body.errors.join(' '), /West is already in use/);
  const team = await rs(g1, { date: '2026-11-07', time: '13:00' }); assert.equal(team.status, 409); assert.match(team.body.errors.join(' '), /TA already plays then/);
  await pool.query(`UPDATE games SET status='active' WHERE id=$1`, [live]); // (startup tidies history-less active rows)
  assert.equal((await rs(live, { date: '2026-11-07', time: '16:00' })).status, 409);
  assert.match((await rs(live, { date: '2026-11-07', time: '16:00' })).body.error, /live/);
  assert.match((await rs(fin, { date: '2026-11-07', time: '16:00' })).body.error, /final/);
  assert.deepEqual(await row(g1), orig); assert.equal(await changes(), 0);
  assert.equal((await rs(g1, { date: 'soon' })).status, 400);

  // time omitted -> the current tip-off (Sat 09:00 -> Fri 09:00); court + lockers unchanged; moved_from + audit set
  const mv = await rs(g1, { date: '2026-11-06', reason: 'gym booked' });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  let r1 = await row(g1);
  assert.equal(r1.at, '2026-11-06 09:00'); assert.equal(r1.mf, '2026-11-07 09:00');
  assert.deepEqual([r1.court_id, r1.home_locker, r1.away_locker], [orig.court_id, '4', 'CH'], 'court and lockers never change');
  // second move: moved_from keeps the FIRST original time
  assert.equal((await rs(g1, { date: '2026-11-07', time: '14:00' })).status, 200);
  r1 = await row(g1); assert.equal(r1.at, '2026-11-07 14:00'); assert.equal(r1.mf, '2026-11-07 09:00', 'first move only');
  const hist = await (await fetch(`${BASE}/api/games/${g1}/changes`, { headers: h })).json();
  assert.equal(hist.length, 2); assert.equal(hist[0].reason, 'gym booked'); assert.equal(hist[0].kind, 'reschedule');
  assert.deepEqual([hist[0].before.date, hist[0].before.time, hist[0].after.date, hist[0].after.time], ['2026-11-07', '09:00', '2026-11-06', '09:00']);
  assert.equal(hist[1].after.home_locker, '4');

  // cheer comes from the new hour; lobby payload carries movedFrom until final; never the court TV payload
  const list = await (await fetch(`${BASE}/api/games`, { headers: h })).json();
  assert.equal(list.find((g: any) => g.id === g1).cheer, 'Spirit');
  let sched = await (await fetch(`${BASE}/api/public/schedule?date=2026-11-07`)).json();
  assert.deepEqual(sched.games.find((g: any) => g.id === g1).movedFrom, { date: '2026-11-07', day: 'Sat', time: '09:00', sameDay: true });
  assert.equal(sched.games.find((g: any) => g.id === g4).movedFrom, undefined);
  for (const c of ['west', 'east', 'full']) assert.doesNotMatch(await (await fetch(`${BASE}/api/public/court/${c}`)).text(), /moved/i, c);

  // CSV: export has read-only moved_from columns; old-time rows (with or without id) keep the move, warn, no duplicate
  const csv = await (await fetch(`${BASE}/api/export/schedule.csv`, { headers: h })).text();
  const lines = csv.trim().split(/\r?\n/); const head = lines[0].split(',');
  assert.ok(head.includes('moved_from_date') && head.includes('moved_from_time'));
  const g1line = lines.find((l) => l.startsWith(`${g1},`))!;
  assert.match(g1line, /2026-11-07,14:00,west/); assert.match(g1line, /2026-11-07,09:00$/);
  const nGames = async () => (await pool.query('SELECT count(*)::int n FROM games')).rows[0].n;
  const n0 = await nGames();
  const imp = async (text: string) => (await fetch(`${BASE}/api/import/schedule.csv`, { method: 'POST', headers: { cookie: h.cookie, 'content-type': 'text/csv' }, body: text })).json();
  const same1 = await imp(csv); assert.equal(same1.updated ?? 0, 0, JSON.stringify(same1));
  const old = g1line.replace('2026-11-07,14:00,west', '2026-11-07,09:00,west');
  const withId = await imp(lines[0] + '\n' + old + '\n');
  assert.match((withId.warnings || []).join(' '), /was rescheduled.*kept the new time/); assert.equal((await row(g1)).at, '2026-11-07 14:00', 'no undo');
  const noId = await imp(lines[0] + '\n' + old.replace(/^\d+,/, ',') + '\n');
  assert.match((noId.warnings || []).join(' '), /was rescheduled/); assert.equal(await nGames(), n0, 'no duplicate');
  assert.equal((await row(g1)).at, '2026-11-07 14:00');

  // plain PUT gets the same-court and team checks
  const put = async (id: number, at: string) => (await fetch(`${BASE}/api/games/${id}`, { method: 'PUT', headers: h, body: JSON.stringify({ scheduled_at: at }) }));
  const g2 = (await pool.query(`SELECT id FROM games WHERE home_team_id=$1`, [T.C])).rows[0].id;
  const p1 = await put(g2, '2026-11-07T14:30:00-06:00'); assert.equal(p1.status, 409); assert.match((await p1.json()).error, /West is already in use/);
  const p2 = await put(g4, '2026-11-07T14:00:00-06:00'); assert.equal(p2.status, 409); assert.match((await p2.json()).error, /TA already plays then/);
  assert.equal((await put(g4, '2026-11-07T16:00:00-06:00')).status, 200, 'a free slot still saves');
  // QA r17: the plain PUT is audited and sets moved_from on the first move only
  assert.equal((await row(g4)).mf, '2026-11-07 13:00');
  assert.equal((await put(g4, '2026-11-07T17:00:00-06:00')).status, 200);
  assert.equal((await row(g4)).mf, '2026-11-07 13:00', 'first move only');
  const h4 = await (await fetch(`${BASE}/api/games/${g4}/changes`, { headers: h })).json();
  assert.deepEqual(h4.map((c: any) => [c.kind, c.before.time, c.after.time]), [['reschedule', '13:00', '16:00'], ['reschedule', '16:00', '17:00']]);
  // ... and follows the Fri/Sat + game-hours rules (409 + errors[]), nothing written
  for (const [at, re] of [['2026-11-09T10:00:00-06:00', /Friday or Saturday/], ['2026-11-07T03:00:00-06:00', /outside game hours/], ['2026-11-07T23:30:00-06:00', /outside game hours/]] as const) {
    const r = await put(g4, at); assert.equal(r.status, 409, at); const j = await r.json(); assert.match(j.errors.join(' '), re, at);
  }
  for (const bad of ['2026-02-30T10:00:00-06:00', '2026-02-31T10:00:00-06:00', 'whenever']) assert.equal((await put(g4, bad)).status, 400, bad);
  assert.equal((await row(g4)).at, '2026-11-07 17:00'); assert.equal((await pool.query('SELECT count(*)::int n FROM game_changes WHERE game_id=$1', [g4])).rows[0].n, 2);
  assert.equal((await fetch(`${BASE}/api/games/${g4}`, { method: 'PUT', headers: h, body: JSON.stringify({ scheduled_at: '2026-11-07T17:00:00-06:00' }) })).status, 200, 'unchanged time: no rule, no audit');
  assert.equal((await pool.query('SELECT count(*)::int n FROM game_changes WHERE game_id=$1', [g4])).rows[0].n, 2);

  // QA r17: game hours on reschedule (GAME_TIP_WINDOW 08:00–21:00 league time, last tip 21:00), real calendar dates
  for (const t of ['03:00', '00:00', '23:30', '07:59', '21:01']) {
    const r = await rs(g4, { date: '2026-11-07', time: t, dryRun: true }); assert.equal(r.status, 409, t); assert.match(r.body.errors.join(' '), /outside game hours \(08:00–21:00/, t);
  }
  for (const t of ['08:00', '21:00']) assert.equal((await rs(g4, { date: '2026-11-07', time: t, dryRun: true })).status, 200, t);
  for (const d of ['2026-02-30', '2026-02-31', '2026-13-01']) { const r = await rs(g4, { date: d, time: '10:00' }); assert.equal(r.status, 400, d); assert.match(r.body.error, /calendar date/); }

  // final -> the note disappears
  await pool.query(`UPDATE games SET status='complete', final_home=1, final_away=0 WHERE id=$1`, [g1]);
  sched = await (await fetch(`${BASE}/api/public/schedule?date=2026-11-07`)).json();
  assert.equal(sched.games.find((g: any) => g.id === g1).movedFrom, undefined);
});

// QA r17 BLOCKER: a SyntaxError in public/lobby.js blanked the lobby. Every browser script must parse.
test('every public/*.js file parses (node --check)', { skip: noPub }, async () => {
  const { execFileSync } = await import('node:child_process');
  const files = fs.readdirSync(PUB).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('lobby.js') && files.length > 5);
  const bad: string[] = [];
  for (const f of files) { try { execFileSync(process.execPath, ['--check', path.join(PUB, f)], { stdio: 'pipe' }); } catch (e: any) { bad.push(`${f}: ${String(e.stderr).split('\n').find((l: string) => /Error/.test(l))}`); } }
  assert.deepEqual(bad, []);
});
