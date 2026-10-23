// Mon–Thu practice schedule: validation, planning/rotation, logos, API + displays (DB part on "<name>_practice").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { validatePractice, slotStarts, DEMO_PRACTICE_DAYS } from '../src/practice.js';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const noPub = !fs.existsSync(path.join(PUB, 'practice-view.js')) && 'public/ not present';
const view = () => import(path.join(PUB, 'practice-view.js'));

test('slots: 1-hour starts in each night\'s range (Wed 4:30–6:30)', () => {
  assert.deepEqual(slotStarts('17:00', '21:00'), ['17:00', '18:00', '19:00', '20:00']);
  assert.deepEqual(slotStarts('16:30', '18:30'), ['16:30', '17:30']);
  assert.deepEqual(slotStarts('17:00', '17:30'), []);
});

test('validatePractice: double-bookings, one court/room per team/squad all season, slot grid, Mon–Thu only', () => {
  const days = [{ day: 1, start: '17:00', end: '19:00' }, { day: 3, start: '16:30', end: '18:30' }];
  const ok = validatePractice({ days, basketball: [{ day: 1, start: '17:00', court: 'west1', teamId: 1 }, { day: 3, start: '16:30', court: 'west1', teamId: 1 }],
    cheer: [{ day: 1, room: ' Room  28/30 ', squadId: 1 }, { day: 3, room: 'room 28/30', squadId: 1 }] });
  assert.deepEqual(ok.errors, []); assert.equal(ok.schedule.cheer[0].room, 'Room 28/30', '"28/30" is one room, spacing tidied');
  const bad = validatePractice({ days: [...days, { day: 5, start: '17:00', end: '18:00' }, { day: 2, start: '17:00', end: '17:30' }], basketball: [
    { day: 1, start: '17:00', court: 'west1', teamId: 1 }, { day: 1, start: '17:00', court: 'west1', teamId: 2 }, // court double-booked
    { day: 1, start: '17:00', court: 'east1', teamId: 1 },  // team on two courts
    { day: 1, start: '18:00', court: 'east2', teamId: 1 },  // team changes court
    { day: 1, start: '17:30', court: 'west2', teamId: 3 },  // not a slot start
    { day: 3, start: '16:30', court: 'north', teamId: 4 },  // unknown court
    { day: 4, start: '17:00', court: 'west1', teamId: 5 }], // Thursday has no hours
  cheer: [{ day: 1, room: 'Foundry', squadId: 1 }, { day: 1, room: 'foundry', squadId: 2 }, { day: 1, room: 'Room 20', squadId: 1 }, { day: 3, room: 'Room 22', squadId: 1 }, { day: 4, room: 'Gym', squadId: 3 }] });
  const e = bad.errors.join('\n');
  for (const re of [/Mon–Thu/, /no full 1-hour slot/, /west1 is double-booked/, /two courts/, /one court all season/, /not a slot start/, /unknown court/, /set the practice hours/, /Foundry is double-booked|foundry is double-booked/, /two rooms/, /one room all season/, /Thursday: set the practice hours before assigning cheer rooms/])
    assert.match(e, re);
});

test('plan: window 60 min before .. 15 after; current from 10 min early; rotation 12 s current / 8 s next', { skip: noPub }, async () => {
  const { planPractice, rotation, nextPracticeText, parsePracticeDemo } = await view();
  const t = (name: string) => ({ name, coach: 'Sam', logo: null });
  const data = { days: [{ day: 1, start: '17:00', end: '19:00' }, { day: 3, start: '16:30', end: '18:30' }],
    basketball: [{ day: 1, start: '17:00', court: 'west1', team: t('A') }, { day: 1, start: '18:00', court: 'east2', team: t('B') }, { day: 3, start: '16:30', court: 'west1', team: t('C') }],
    cheer: [{ day: 1, room: 'Room 20', slotId: 1, squad: t('Q') }] };
  assert.equal(planPractice(data, 'basketball', 1, '15:59').mode, 'idle');
  const pre = planPractice(data, 'basketball', 1, '16:00');
  assert.equal(pre.mode, 'practice'); assert.equal(pre.current, null); assert.equal(pre.startsText, 'Starts 5:00 PM');
  assert.deepEqual([0, 11, 12, 24].map((s) => rotation(pre, s).index), [0, 0, 1, 0], 'before start: all slots, 12 s each');
  assert.equal(planPractice(data, 'basketball', 1, '16:49').current, null);
  assert.equal(planPractice(data, 'basketball', 1, '16:50').current, 0, '10 min early');
  const p = planPractice(data, 'basketball', 1, '17:20');
  assert.deepEqual([rotation(p, 0), rotation(p, 11), rotation(p, 12), rotation(p, 19), rotation(p, 20)].map((r) => `${r.index}${r.state[0]}`), ['0c', '0c', '1n', '1n', '0c']);
  assert.equal(p.pages[0].courts.west1.team.name, 'A'); assert.equal(p.pages[0].courts.east1, null, 'open court');
  assert.equal(p.header, 'MONDAY');
  const last = planPractice(data, 'basketball', 1, '19:10'); assert.equal(last.current, 1); assert.equal(rotation(last, 15).index, 1, 'last slot: no next');
  assert.equal(planPractice(data, 'basketball', 1, '19:15').mode, 'idle', '15 min after the end');
  assert.equal(planPractice(data, 'basketball', 3, '16:30').pages.length, 2, 'Wed 4:30–6:30');
  const ch = planPractice(data, 'cheer', 1, '18:00'); assert.equal(ch.header, 'MONDAY CHEER'); assert.equal(ch.pages[0][0].room, 'Room 20');
  assert.equal(planPractice(data, 'cheer', 3, '17:00').mode, 'idle', 'no cheer on Wednesday');
  assert.equal(nextPracticeText(data, 'basketball', 2, '12:00'), 'Next practice: Wed 4:30 PM');
  assert.equal(nextPracticeText(data, 'cheer', 1, '20:00'), 'Next practice: Mon 5:00 PM', 'next week');
  const many = { ...data, cheer: Array.from({ length: 11 }, (_, i) => ({ day: 1, room: 'R' + i, slotId: i, squad: t('S' + i) })) };
  assert.deepEqual(planPractice(many, 'cheer', 1, '17:00').pages.map((x: any[]) => x.length), [9, 2]);
  assert.deepEqual(parsePracticeDemo(new URLSearchParams('day=mon&at=17:10')), { dow: 1, hm: '17:10' });
  assert.deepEqual(parsePracticeDemo(new URLSearchParams('at=9:05')), { dow: null, hm: '09:05' });
  assert.equal(parsePracticeDemo(new URLSearchParams('')), null);
});

test('practice screens render logo or initial badge (shared helper)', { skip: noPub }, async () => {
  const src = fs.readFileSync(path.join(PUB, 'practice.js'), 'utf8');
  assert.match(src, /mascotHtml\(logo, name\)/); assert.match(src, /x\.team\.logo/); assert.match(src, /x\.squad\.logo/);
  const { mascotHtml } = await import(path.join(PUB, 'logo-badge.js'));
  assert.match(mascotHtml('/team-logos/cheer/foundry.png', 'Hype'), /<img/); assert.match(mascotHtml(null, 'hype crew'), />H</);
});

const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test"' : false;
let db: typeof import('../src/db.js'); let srv: ChildProcess | null = null; let URL_ = '';
const PORT = 37000 + Math.floor(Math.random() * 2000), BASE = `http://127.0.0.1:${PORT}`, ADMIN = 'practice-admin-pw';
before(async () => {
  if (skip) return;
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_practice'; u.pathname = '/' + name; URL_ = u.toString();
  const admin = new pg.Client({ connectionString: BASE_URL }); await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.DATABASE_URL = URL_; process.env.TZ = 'America/Chicago';
  db = await import('../src/db.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
after(async () => { srv?.kill(); await db?.pool.end(); });

test('DB: additive migration, demo seed = 44 teams once a week on one court + 4 squads Mon/Thu; API, admin save, pages', { skip }, async () => {
  const { pool } = db;
  await db.migrate(); await db.migrate(); // idempotent
  await db.seedDemo('reset');
  const { loadLogos } = await import('../src/logo-files.js'); await loadLogos(pool);
  const n = (await pool.query(`SELECT count(*)::int n, count(DISTINCT team_id)::int t FROM practice_slots WHERE kind='basketball'`)).rows[0];
  assert.deepEqual(n, { n: 44, t: 44 });
  assert.deepEqual((await pool.query(`SELECT day_of_week d, count(*)::int n FROM practice_slots WHERE kind='cheer' GROUP BY 1 ORDER BY 1`)).rows, [{ d: 1, n: 4 }, { d: 4, n: 4 }]);
  assert.deepEqual((await pool.query(`SELECT day_of_week d, to_char(start_time,'HH24:MI') s, to_char(end_time,'HH24:MI') e FROM practice_days ORDER BY 1`)).rows.map((r) => [r.d, r.s, r.e]), DEMO_PRACTICE_DAYS.map((d) => [d.day, d.start, d.end]));
  const { seedPracticeDemo } = await import('../src/practice.js');
  assert.equal(await seedPracticeDemo(pool), false, 'fills only an empty schedule');
  // a team logo cleared -> null (display falls back to the badge)
  const tid = (await pool.query(`SELECT team_id FROM practice_slots WHERE kind='basketball' ORDER BY id LIMIT 1`)).rows[0].team_id;
  await pool.query(`UPDATE teams SET logo_url=NULL WHERE id=$1`, [tid]);

  srv = spawn(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server.js')], {
    env: { ...process.env, DATABASE_URL: URL_, PORT: String(PORT), ADMIN_PASSWORD: ADMIN, TZ: 'America/Chicago', SEED: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout!.on('data', (x) => (log += x)); srv.stderr!.on('data', (x) => (log += x));
  for (let i = 0; i < 100 && !/listening/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
  const pub = await (await fetch(BASE + '/api/public/practice')).json();
  assert.equal(pub.basketball.length, 44); assert.equal(pub.cheer.length, 8);
  assert.ok(pub.now.dow >= 0 && pub.now.dow <= 6); assert.match(pub.now.hm, /^\d\d:\d\d$/);
  assert.equal(pub.basketball.filter((x: any) => x.team.logo === null).length, 1, 'cleared logo -> null');
  assert.ok(pub.basketball.filter((x: any) => x.team.logo).every((x: any) => x.team.logo.startsWith('/team-logos/teams/')));
  assert.ok(pub.cheer.every((x: any) => x.squad.logo?.startsWith('/team-logos/cheer/')));
  assert.equal(JSON.stringify(pub).includes('teamId'), false, 'public payload carries no ids');
  for (const u of ['/upwardbasketballscores/practice/cheer', '/upwardbasketballscores/practice/basketball', '/practice/cheer', '/practice/basketball/', '/admin/practice']) {
    const r = await fetch(BASE + u); assert.equal(r.status, 200, u); assert.match(r.headers.get('content-type') || '', /text\/html/);
  }
  assert.equal((await fetch(BASE + '/practice/football')).status, 404);
  assert.equal((await fetch(BASE + '/api/practice')).status, 401, 'admin only');
  const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const h = { cookie, 'content-type': 'application/json' };
  const cur = await (await fetch(BASE + '/api/practice', { headers: h })).json();
  assert.equal(cur.teams.length, 44); assert.equal(cur.squads.length, 4);
  const week = { days: cur.days, basketball: cur.basketball.map((x: any) => ({ day: x.day, start: x.start, court: x.court, teamId: x.teamId })), cheer: cur.cheer.map((x: any) => ({ day: x.day, room: x.room, squadId: x.squadId })) };
  const dup = { ...week, basketball: [...week.basketball, { ...week.basketball[0], teamId: week.basketball[5].teamId }] };
  const r400 = await fetch(BASE + '/api/practice', { method: 'PUT', headers: h, body: JSON.stringify(dup) });
  assert.equal(r400.status, 400); assert.match((await r400.json()).errors.join(' '), /double-booked/);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM practice_slots`)).rows[0].n, 52, 'rejected save changed nothing');
  // Wednesday 4:30–6:30 -> 5:00–6:00 drops to one slot; the client trims outside slots before saving
  const wed = { ...week, days: week.days.map((d: any) => (d.day === 3 ? { ...d, start: '17:00', end: '18:00' } : d)), basketball: week.basketball.filter((b: any) => b.day !== 3).concat([{ day: 3, start: '17:00', court: 'east2', teamId: week.basketball.find((b: any) => b.day === 3).teamId }]) };
  // QA r17: a save that removes saved teams needs confirmRemove: true, else 409 + errors[] and nothing changes
  const w409 = await fetch(BASE + '/api/practice', { method: 'PUT', headers: h, body: JSON.stringify(wed) });
  assert.equal(w409.status, 409); const wj = await w409.json();
  assert.equal(wj.errors.length, 8, 'the 8 Wednesday teams that leave are listed'); assert.match(wj.errors[0], /^Wed 1\d:\d\d \w+: .+ would be removed$/);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM practice_slots WHERE day_of_week=3`)).rows[0].n, 8, 'unconfirmed save changed nothing');
  // Tuesday turned off (Avery r17 repro): 409 listing all 16 teams, Tuesday kept
  const tueOff = { ...week, days: week.days.filter((d: any) => d.day !== 2), basketball: week.basketball.filter((b: any) => b.day !== 2) };
  const t409 = await fetch(BASE + '/api/practice', { method: 'PUT', headers: h, body: JSON.stringify(tueOff) });
  assert.equal(t409.status, 409); assert.equal((await t409.json()).errors.filter((e: string) => e.startsWith('Tue ')).length, 16);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM practice_slots WHERE day_of_week=2`)).rows[0].n, 16, 'Tuesday kept');
  assert.equal((await fetch(BASE + '/api/practice', { method: 'PUT', headers: h, body: JSON.stringify({ ...tueOff, confirmRemove: 'yes' }) })).status, 409, 'only literal true confirms');
  const ok = await fetch(BASE + '/api/practice', { method: 'PUT', headers: h, body: JSON.stringify({ ...wed, confirmRemove: true }) });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual((await pool.query(`SELECT count(*)::int n FROM practice_slots WHERE day_of_week=3`)).rows[0], { n: 1 });
  const fk = await fetch(BASE + '/api/practice', { method: 'PUT', headers: h, body: JSON.stringify({ ...wed, cheer: [{ day: 1, room: 'X', squadId: 99999 }], confirmRemove: true }) });
  assert.equal(fk.status, 400);
  // QA NO-GO (Avery): unknown team/squad -> errors[]; malformed bodies never wipe the week; hours change never drops silently
  assert.ok(Array.isArray((await fk.json()).errors), 'unknown squad has errors[]');
  const before = (await pool.query(`SELECT count(*)::int n FROM practice_slots`)).rows[0].n;
  for (const bad of ['null', '[]', '{}', '{"days":[]}', 'not json']) {
    const r = await fetch(BASE + '/api/practice', { method: 'PUT', headers: h, body: bad });
    assert.equal(r.status, 400, bad); assert.ok((await r.json()).errors.length, bad);
  }
  assert.equal((await pool.query(`SELECT count(*)::int n FROM practice_slots`)).rows[0].n, before, 'malformed bodies changed nothing');
  // Thursday 5–6 PM -> 5:30–6:30: the 5:00 teams no longer fit -> 400 with errors, nothing saved (was: silently dropped, "Saved")
  const thu = { ...wed, days: wed.days.map((d: any) => (d.day === 4 ? { ...d, start: '17:30', end: '18:30' } : d)) };
  const rThu = await fetch(BASE + '/api/practice', { method: 'PUT', headers: h, body: JSON.stringify(thu) });
  assert.equal(rThu.status, 400); assert.match((await rThu.json()).errors.join(' '), /Thursday 17:00: not a slot start/);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM practice_slots WHERE day_of_week=4 AND kind='basketball'`)).rows[0].n, 4, 'Thursday teams kept');
  // hours widened: every slot still fits -> saved, teams kept
  const thu2 = { ...wed, days: wed.days.map((d: any) => (d.day === 4 ? { ...d, start: '17:00', end: '19:00' } : d)) };
  assert.equal((await fetch(BASE + '/api/practice', { method: 'PUT', headers: h, body: JSON.stringify(thu2) })).status, 200);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM practice_slots WHERE day_of_week=4 AND kind='basketball'`)).rows[0].n, 4);
  // cheer room on a night with no hours -> 400
  const noHours = { ...thu2, days: thu2.days.filter((d: any) => d.day !== 2), basketball: thu2.basketball.filter((b: any) => b.day !== 2), cheer: [{ day: 2, room: 'Room 20', squadId: cur.squads[0].id }] };
  const rc = await fetch(BASE + '/api/practice', { method: 'PUT', headers: h, body: JSON.stringify(noHours) });
  assert.equal(rc.status, 400); assert.match((await rc.json()).errors.join(' '), /Tuesday: set the practice hours before assigning cheer rooms/);
  // public payload: no slotId / ids
  const pub2 = await (await fetch(BASE + '/api/public/practice')).json();
  assert.ok(pub2.cheer.length && pub2.cheer.every((x: any) => !('slotId' in x) && !('squadId' in x)));
  // explicit, well-formed empty week clears it
  assert.equal((await fetch(BASE + '/api/practice', { method: 'PUT', headers: h, body: JSON.stringify({ days: [], basketball: [], cheer: [] }) })).status, 409, 'clearing needs confirmRemove');
  assert.equal((await fetch(BASE + '/api/practice', { method: 'PUT', headers: h, body: JSON.stringify({ days: [], basketball: [], cheer: [], confirmRemove: true }) })).status, 200);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM practice_slots`)).rows[0].n, 0);
  const adminSrc = fs.readFileSync(path.join(PUB, 'practice-admin.js'), 'utf8');
  assert.match(adminSrc, /confirm\(`This save removes \$\{removed.length\} practice slot/, 'editor asks before removing slots');
  assert.match(adminSrc, /confirmRemove: true/);
  assert.doesNotMatch(adminSrc, /week\.basketball = week\.basketball\.filter\(\(x\) => x\.day !== cur\)/, 'unchecking a night no longer deletes its teams');
});
