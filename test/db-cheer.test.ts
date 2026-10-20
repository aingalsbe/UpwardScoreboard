// Database integration tests for locker rooms, coaches and cheer by time slot (phase 1).
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://.../<name containing "test"> npm test
// The database is WIPED (schema public dropped). Skipped when TEST_DATABASE_URL is not set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { hasCoachKey } from '../src/payload.js';

const URL_ = process.env.TEST_DATABASE_URL || '';
const skip = !URL_ ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(URL_).pathname) ? 'TEST_DATABASE_URL database name must contain "test" (it is wiped)' : false;
const PORT = 31000 + Math.floor(Math.random() * 2000), BASE = `http://127.0.0.1:${PORT}`, ADMIN = 'test-admin-pw';
let db: typeof import('../src/db.js'); let srv: ChildProcess | null = null; let token = '';

const api = async (p: string, opts: { method?: string; body?: unknown; csv?: string } = {}) => {
  const r = await fetch(BASE + p, { method: opts.method || (opts.body || opts.csv ? 'POST' : 'GET'), headers: { authorization: `Bearer ${token}`, 'content-type': opts.csv ? 'text/csv' : 'application/json' }, body: opts.csv ?? (opts.body ? JSON.stringify(opts.body) : undefined) });
  const t = (await r.text()).replace(/\r\n/g, '\n'); let b: any; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = URL_; process.env.TZ = 'America/Chicago';
  db = await import('../src/db.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
after(async () => { srv?.kill(); await db?.pool.end(); });

test('migration: backfills squads + hour slots from per-game cheer, reports conflicts, re-runs safely', { skip }, async () => {
  const { pool } = db;
  await pool.query(db.SCHEMA); // tables exist, backfill not yet run (an old database just upgraded)
  await pool.query(`INSERT INTO courts(slug, name, conflicts_with) VALUES ('full','Full','{west,east}'),('west','West','{}'),('east','East','{}')`);
  const team = async (n: string) => (await pool.query(`INSERT INTO teams(name, short_name, grade, grade_order, gender) VALUES ($1,upper($1),'2nd Grade',2,'Boys') RETURNING id`, [n])).rows[0].id;
  const ids: number[] = []; for (const n of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']) ids.push(await team(n));
  const game = async (court: string, at: string, h: number, a: number, cheer: string | null, logo: Buffer | null = null) => pool.query(
    `INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, cheer, cheer_logo_data, cheer_logo_mime) VALUES ((SELECT id FROM courts WHERE slug=$1), $2, $3, $4::timestamp AT TIME ZONE 'America/Chicago', $5, $6, $7)`,
    [court, h, a, at, cheer, logo, logo ? 'image/png' : null]);
  await game('west', '2026-10-24 09:00', ids[0], ids[1], 'Pep Power', Buffer.from('png'));
  await game('east', '2026-10-24 09:05', ids[2], ids[3], ' pep power '); // same squad, same slot (09:05 -> 09:00)
  await game('west', '2026-10-24 10:00', ids[4], ids[5], 'Sparkle');
  await game('east', '2026-10-24 10:10', ids[6], ids[7], 'Joyful Noise'); // conflict in the 10:00 slot
  await game('west', '2026-10-24 11:00', ids[0], ids[2], null);
  await db.migrate();
  const squads = (await pool.query('SELECT name, (logo_data IS NOT NULL) AS up FROM cheer_squads ORDER BY name')).rows;
  assert.deepEqual(squads.map((s) => s.name), ['Joyful Noise', 'Pep Power', 'Sparkle']);
  assert.equal(squads.find((s) => s.name === 'Pep Power').up, true, 'logo moved to the squad');
  const slots = async () => (await pool.query(`SELECT to_char(date,'YYYY-MM-DD') d, to_char(slot_start,'HH24:MI') s, q.name FROM cheer_slots JOIN cheer_squads q ON q.id=squad_id ORDER BY 1,2`)).rows;
  assert.deepEqual(await slots(), [{ d: '2026-10-24', s: '09:00', name: 'Pep Power' }]);
  assert.deepEqual(await db.legacyCheerConflicts(), [{ date: '2026-10-24', start: '10:00', candidates: ['Joyful Noise', 'Sparkle'] }]);
  // re-run (startup again) and a forced re-run: nothing duplicated, old columns untouched
  await db.migrate(); const forced = await db.migrateCheerSlots(true);
  assert.equal(forced.squads + forced.slots, 0); assert.equal(forced.conflicts.length, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM cheer_squads')).rows[0].n, 3);
  assert.equal((await slots()).length, 1);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM games WHERE cheer IS NOT NULL`)).rows[0].n, 4, 'games.cheer is kept (read-only)');
});

test('server: warnings, CRUD, CSV round-trip + legacy files, scorekeeper never gets a coach', { skip }, async () => {
  srv = spawn(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server.js')], {
    env: { ...process.env, DATABASE_URL: URL_, PORT: String(PORT), ADMIN_PASSWORD: ADMIN, TZ: 'America/Chicago', SEED: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; srv.stdout!.on('data', (d) => (log += d)); srv.stderr!.on('data', (d) => (log += d));
  for (let i = 0; i < 100 && !/listening/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(log, /listening/, log);
  token = (await api('/api/login', { body: { password: ADMIN } })).body.token;

  // conflict -> warning with candidates; picking a squad for the slot clears it
  let w = (await api('/api/warnings')).body;
  const conflict = w.find((x: any) => x.code === 'cheer-slot-conflict');
  assert.deepEqual(conflict?.candidates, ['Joyful Noise', 'Sparkle']); assert.equal(conflict.gameId, null);
  const squads = (await api('/api/cheer-squads')).body;
  const sparkle = squads.find((s: any) => s.name === 'Sparkle');
  const created = await api('/api/cheer-slots', { body: { date: '2026-10-24', time: '10:00', squad_id: sparkle.id, locker: '1' } });
  assert.equal(created.status, 201);
  assert.equal((await api('/api/cheer-slots', { body: { date: '2026-10-24', time: '10:30', squad_id: sparkle.id } })).status, 409, 'one squad per hour');
  // a slot with no games -> cheer-slot-empty
  const empty = await api('/api/cheer-slots', { body: { date: '2026-10-24', time: '15:00', squad: 'Sparkle' } });
  w = (await api('/api/warnings')).body;
  assert.equal(w.some((x: any) => x.code === 'cheer-slot-conflict'), false);
  assert.ok(w.some((x: any) => x.code === 'cheer-slot-empty' && x.slot.start === '15:00'));
  await api(`/api/cheer-slots/${empty.body.id}`, { method: 'DELETE' });
  assert.equal((await api(`/api/cheer-squads/${sparkle.id}`, { method: 'DELETE' })).status, 409, 'squad in use');
  assert.equal((await fetch(`${BASE}/api/cheer-squads`)).status, 401, 'admin only');

  // CSV imports: coaches, squads, slots, lockers
  const teamsCsv = 'name,grade,gender,coach\nT1,2nd Grade,Boys,Mike\nT2,2nd Grade,Boys,Coach Sarah\n';
  let r = (await api('/api/import/teams.csv', { csv: teamsCsv })).body; assert.deepEqual([r.updated, r.errors], [2, []]);
  assert.equal((await api('/api/import/teams.csv', { csv: teamsCsv })).body.skipped, 2, 'idempotent');
  r = (await api('/api/import/teams.csv', { csv: 'name,grade,gender\nT1,2nd Grade,Boys\n' })).body; assert.equal(r.skipped, 1, 'absent coach column = keep');
  r = (await api('/api/import/cheer_squads.csv', { csv: 'name,coach\nPep Power,Amy\nNew Squad,Beth\n' })).body; assert.deepEqual([r.created, r.updated, r.errors], [1, 1, []]);
  r = (await api('/api/import/cheer_slots.csv', { csv: 'date,time,squad,locker\n2026-10-24,09:00,Pep Power,3\n2026-10-24,11:05,New Squad,\n2026-10-24,12:00,Nobody,\n' })).body;
  assert.deepEqual([r.created, r.updated], [1, 1]); assert.match(r.errors.join(), /unknown cheer squad "Nobody"/); assert.match(r.warnings.join(), /11:05 is in the 11:00 slot/);
  let sched = (await api('/api/export/schedule.csv')).body as string;
  assert.match(sched.split('\n')[0], /home_locker,away_locker$/); assert.doesNotMatch(sched.split('\n')[0], /cheer/);
  const lines = sched.trim().split('\n'); lines[1] = lines[1].replace(/,,$/, ',CH,5');
  r = (await api('/api/import/schedule.csv', { csv: lines.join('\n') + '\n' })).body; assert.deepEqual([r.updated, r.errors], [1, []]);

  // round-trip: export every file, re-import, nothing changes
  for (const f of ['teams', 'schedule', 'cheer_squads', 'cheer_slots']) {
    const csv = (await api(`/api/export/${f}.csv`)).body as string;
    const res = (await api(`/api/import/${f}.csv`, { csv })).body;
    assert.deepEqual([f, res.created, res.updated, res.errors], [f, 0, 0, []], JSON.stringify(res));
  }
  const slotsCsv = (await api('/api/export/cheer_slots.csv')).body as string;
  assert.equal(slotsCsv.trim(), 'date,time,squad,locker\n2026-10-24,09:00,Pep Power,3\n2026-10-24,10:00,Sparkle,1\n2026-10-24,11:00,New Squad,');
  // blank locker cell clears; blank squad deletes the slot
  r = (await api('/api/import/cheer_slots.csv', { csv: 'date,time,squad,locker\n2026-10-24,09:00,Pep Power,\n2026-10-24,11:00,,\n' })).body; assert.equal(r.updated, 2);
  assert.equal(((await api('/api/cheer-slots?date=2026-10-24')).body as any[]).map((s) => `${s.time}:${s.locker}`).join(' '), '09:00:null 10:00:1');

  // legacy schedule.csv with a cheer column (old per-game files) maps to slots; a conflicting row warns
  const legacy = 'date,time,court,home,away,cheer\n2026-10-24,11:00,west,T1,T3,Legacy Cheer\n2026-10-24,12:00,east,T5,T6,Legacy Cheer\n2026-10-24,12:00,west,T7,T8,Other Cheer\n';
  r = (await api('/api/import/schedule.csv', { csv: legacy })).body;
  assert.equal(r.created, 2); assert.match(r.warnings.join('|'), /conflicts with "Legacy Cheer"/);
  assert.match(r.warnings.join('|'), /2 cheer slot\(s\) set/);
  assert.deepEqual(((await api('/api/cheer-slots?date=2026-10-24')).body as any[]).map((s) => `${s.time} ${s.squad}`), ['09:00 Pep Power', '10:00 Sparkle', '11:00 Legacy Cheer', '12:00 Legacy Cheer']);
  r = (await api('/api/import/schedule.csv', { csv: legacy })).body;
  assert.deepEqual([r.created, r.updated], [0, 0], 'legacy re-import is idempotent'); assert.doesNotMatch(r.warnings.join('|'), /slot\(s\) set/);
  // even older home_cheer/away_cheer columns
  r = (await api('/api/import/schedule.csv', { csv: 'date,time,court,home,away,home_cheer,away_cheer\n2026-10-24,13:00,west,T2,T4,,Old Side Cheer\n' })).body;
  assert.equal(r.created, 1);
  assert.ok(((await api('/api/cheer-slots?date=2026-10-24')).body as any[]).some((s) => s.time === '13:00' && s.squad === 'Old Side Cheer'));

  // snapshots: TV sees lockers + coaches + the slot's squad on both courts; the scorekeeper sees no coach at all
  const g9 = ((await api('/api/games')).body as any[]).find((g) => g.home === 'T1' && g.away === 'T2');
  assert.equal(g9.cheer, 'Pep Power');
  assert.equal((await api(`/api/games/${g9.id}/start`, { body: {} })).status, 200);
  const first = (role: string) => new Promise<any>((ok, bad) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?court=west&role=${role}`, { headers: { authorization: `Bearer ${token}` } });
    ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'state') { ws.close(); ok(m); } });
    ws.on('error', bad); setTimeout(() => bad(new Error('no state')), 3000);
  });
  const tv = await first('tv');
  assert.equal(tv.game.home.coach, 'Mike'); assert.equal(tv.game.away.coach, 'Sarah'); assert.equal(tv.game.home.locker, 'CH');
  assert.deepEqual([tv.game.cheer.name, tv.game.cheer.coach, tv.game.cheer.slot.start], ['Pep Power', 'Amy', '09:00']);
  const east = ((await api('/api/games')).body as any[]).find((g) => g.home === 'T3' && g.away === 'T4');
  assert.equal(east.cheer, 'Pep Power', 'the 09:05 East game shares the 09:00 slot');
  const score = await first('score');
  assert.equal(hasCoachKey(score), false, JSON.stringify(score));
  assert.equal(score.game.id, g9.id); assert.equal(score.game.home.locker, 'CH'); assert.equal('cheer' in score.game, false);
  const sched2 = (await (await fetch(`${BASE}/api/public/schedule?date=2026-10-24`)).json()) as any;
  assert.deepEqual(sched2.cheerSlots.map((s: any) => s.start), ['09:00', '10:00', '11:00', '12:00', '13:00']);
});
