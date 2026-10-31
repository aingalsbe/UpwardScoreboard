// Real 2027 season import. Parsing tests always run. The database half needs
// TEST_DATABASE_URL (database name containing "test"); it uses its own database "<name>_season".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { periodsPerHalf } from '../src/game.js';
import { cheerSlotWarnings, hourSlot, scheduleWarnings, WarnGame } from '../src/schedule.js';
import {
  SeasonPlan, buildSeasonPlan, formatSeasonReport, gameNaturalKey, mapGameCourt, mapPracticeCourt,
  normalizeDivisionName, normalizePerson, normalizeSpaces, readSeasonCsvs, replacementDecision, teamKey,
  type SeasonFiles,
} from '../src/season-import.js';
import { startServer } from './_server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = fs.existsSync(path.resolve(here, '../../data/season-2027')) ? path.resolve(here, '../..') : path.resolve(here, '..');
const FIX = path.join(repoRoot, 'test/fixtures/season-2027');
const badFiles: SeasonFiles = {
  games: path.join(FIX, 'games.csv'),
  basketballPractice: path.join(FIX, 'basketball.csv'),
  cheerGames: path.join(FIX, 'cheer-games.csv'),
  cheerPractice: path.join(FIX, 'cheer-practice.csv'),
};

const EXPECTED = [
  ['Kindergarten', 6, 24],
  ['1st-2nd Grade Boys', 12, 48],
  ['1st-2nd Grade Girls', 4, 16],
  ['3rd-4th Grade Boys', 12, 48],
  ['3rd-4th Grade Girls', 6, 24],
  ['5th-6th Grade Boys', 8, 32],
  ['5th-6th Grade Girls', 4, 16],
] as const;

const plan: SeasonPlan = buildSeasonPlan(readSeasonCsvs());
test('real CSVs match the 2027 counts', () => {
  assert.deepEqual(plan.divisions.map((d) => [d.division, d.teams, d.games]), EXPECTED.map((r) => [...r]));
  assert.equal(plan.teams.length, 52);
  assert.equal(plan.games.length, 208);
  assert.deepEqual(plan.gamesByCourt, { west: 80, east: 80, full: 48 });
  assert.ok(plan.games.filter((g) => g.court === 'full').every((g) => g.grade === '5th-6th Grade'));
  assert.equal(plan.fridayLate, 16);
  assert.equal(new Set(plan.games.map((g) => g.date)).size, 16);
  assert.deepEqual([1, 2, 3, 4].map((d) => plan.basketballByDay[d]), [16, 16, 4, 16]);
  assert.equal(plan.basketballSlots.length, 52);
  assert.equal(plan.basketballDatedRows, 468);
  const courts = { west1: 0, west2: 0, east1: 0, east2: 0 } as Record<string, number>;
  for (const s of plan.basketballSlots) courts[s.court]++;
  assert.deepEqual(courts, { west1: 13, west2: 13, east1: 13, east2: 13 });
  assert.equal(plan.cheerSquads.length, 10);
  const squads = new Map<string, number>();
  for (const s of plan.cheerSquads) squads.set(s.division, (squads.get(s.division) || 0) + 1);
  assert.equal(squads.get('Kindergarten'), 2);
  assert.equal(squads.get('1st-2nd Grade Girls'), 4);
  assert.equal(squads.get('3rd-4th Grade Girls'), 3);
  assert.equal(squads.get('5th-6th Grade Girls'), 1);
  assert.equal(plan.cheerSlots.length, 80);
  assert.deepEqual([1, 4].map((d) => plan.cheerPracticeByDay[d]), [7, 3]);
  assert.equal(plan.cheerPracticeSlots.length, 10);
  assert.equal(plan.cheerPracticeDatedRows, 90);
  const plays = new Map<string, number>();
  for (const g of plan.games) for (const n of [g.home, g.away]) plays.set(teamKey(g.division, n), (plays.get(teamKey(g.division, n)) || 0) + 1);
  assert.ok([...plays.values()].every((n) => n === 8));
});

test('normalization, courts, blank coaches, and the Spirit Squad warning', () => {
  assert.equal(normalizeSpaces('Erin  Friesen'), 'Erin Friesen');
  assert.equal(normalizeSpaces(' Room 22 '), 'Room 22');
  assert.equal(normalizeDivisionName('1st - 2nd Grade Girls'), '1st-2nd Grade Girls');
  assert.equal(normalizeDivisionName('3rd-4th Grade Boys '), '3rd-4th Grade Boys');
  assert.equal(normalizeDivisionName('5th-6th Grade Girls '), '5th-6th Grade Girls');
  assert.equal(normalizePerson(''), null);
  assert.equal(normalizePerson('   '), null);
  assert.equal(normalizePerson('nan'), null);
  assert.equal(normalizePerson('Coach  Erin  Friesen'), 'Erin Friesen');
  assert.equal(mapGameCourt('Game Court - West'), 'west');
  assert.equal(mapGameCourt('Game Court - East'), 'east');
  assert.equal(mapGameCourt('Game Court - Full'), 'full');
  assert.equal(mapPracticeCourt('WEST 1'), 'west1');
  assert.equal(mapPracticeCourt('WEST 2'), 'west2');
  assert.equal(mapPracticeCourt('EAST 1'), 'east1');
  assert.equal(mapPracticeCourt('EAST 2'), 'east2');
  assert.throws(() => mapGameCourt('Gym'), /unknown game court/);

  const coachOf = (division: string, name: string) => plan.teams.find((t) => t.division === division && t.name === name)?.coach;
  assert.equal(coachOf('1st-2nd Grade Girls', 'Lady Hurricanes'), 'Heather Mitchell');
  assert.equal(coachOf('1st-2nd Grade Girls', 'Lady Terrapins'), 'Kevin Shell');
  assert.equal(coachOf('1st-2nd Grade Boys', 'Wolfpack'), null);
  assert.equal(coachOf('3rd-4th Grade Boys', 'Buckeyes'), null);
  const blanks = plan.teams.filter((t) => t.coach == null).map((t) => t.name).sort();
  assert.deepEqual(blanks, ['Bobcats', 'Buckeyes', 'Raiders', 'Wolfpack']);
  for (const t of [...plan.teams, ...plan.cheerSquads]) {
    if (t.coach) {
      assert.ok(t.coach.length <= 30, t.coach);
      assert.doesNotMatch(t.coach, /\s{2}/);
    }
  }
  assert.ok(plan.teams.some((t) => t.name === 'Lady Hurricanes'));
  assert.ok(plan.teams.filter((t) => t.gender === 'Girls').every((t) => t.name.startsWith('Lady ')));
  assert.ok(plan.cheerSquads.some((s) => s.coach === 'Kathy Wolfe' && s.division === '1st-2nd Grade Girls'));
  assert.ok(plan.cheerSquads.every((s) => !s.division.includes(' - ')));
  assert.ok(plan.cheerPracticeSlots.some((s) => s.room === 'Room 22'));
  assert.ok(plan.cheerPracticeSlots.every((s) => s.room === s.room.trim()));
  for (const s of plan.cheerSlots) assert.equal('court' in s, false);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /Spirit Squad/);
  assert.match(plan.warnings[0], /6:30/);
  assert.match(plan.warnings[0], /not stored/);
  assert.doesNotMatch(plan.warnings[0], /late|overlap|court/i);

  const ids = new Map<string, number>();
  let n = 1;
  const idOf = (k: string) => ids.get(k) ?? (ids.set(k, n), n++);
  const cheerAt = new Set(plan.cheerSlots.map((s) => `${s.date}|${s.hour}`));
  const games: WarnGame[] = plan.games.map((g, i) => {
    const [h, m] = g.time.split(':').map(Number);
    return {
      id: i + 1, date: g.date, startMin: h * 60 + m, durMin: 60, court: g.court, grade: g.grade, label: g.division,
      homeId: idOf(teamKey(g.division, g.home)), awayId: idOf(teamKey(g.division, g.away)), home: g.home, away: g.away,
      hasCheer: cheerAt.has(`${g.date}|${hourSlot(g.time)}`),
    };
  });
  assert.deepEqual(scheduleWarnings(games), []);
  assert.deepEqual(cheerSlotWarnings(plan.cheerSlots.map((s) => ({ date: s.date, start: s.hour, squad: s.squad })), games, []), []);
  const report = formatSeasonReport(plan);
  assert.match(report, /Kindergarten: 6 teams, 24 games/);
  assert.match(report, /Total: 52 teams, 208 games/);
  assert.match(report, /Games by court: west 80, east 80, full 48/);
  assert.match(report, /Friday 8:15 PM games: 16/);
  assert.match(report, /Practice slots by day: Mon 16, Tue 16, Wed 4, Thu 16 \(52 weekly, 468 dated rows\)/);
  assert.match(report, /Cheer squads: 10/);
  assert.match(report, /Cheer slots: 80/);
  assert.match(report, /Cheer practice slots: Mon 7, Thu 3 \(10 weekly, 90 dated rows\)/);
  assert.match(report, /Spirit Squad/);
});

test('replacement: empty, this season, demo, or foreign', () => {
  const games = plan.games;
  assert.equal(replacementDecision([], games).kind, 'empty');
  assert.equal(replacementDecision(games, games).kind, 'season');
  assert.equal(replacementDecision([games[0]], games).kind, 'season');
  assert.equal(replacementDecision([{ date: '2026-10-17', time: '09:00', court: 'west', home: 'Eagles', away: 'Lions' }], games).kind, 'demo');
  const foreign = replacementDecision([{ date: '2030-01-04', time: '09:00', court: 'west', home: 'Sentinel Home', away: 'Sentinel Away' }], games);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.kind, 'foreign');
  assert.match(foreign.reason || '', /--reset/);
  assert.equal(gameNaturalKey(games[0]), `${games[0].date}|${games[0].time}|${games[0].court}|${games[0].home}|${games[0].away}`);
});

test('a malformed CSV is rejected before it names a database', () => {
  assert.throws(() => buildSeasonPlan(readSeasonCsvs(badFiles)), /game schedule is missing column/);
});

test('cheer markup and the schedule payload carry no court', () => {
  const pub = path.join(repoRoot, 'public');
  const lobby = fs.readFileSync(path.join(pub, 'lobby.js'), 'utf8');
  const band = lobby.slice(lobby.indexOf('const cheerBand'), lobby.indexOf('const courtsOf'));
  assert.match(band, /data-court="both"/);
  assert.doesNotMatch(band, /Full|West|East/);
  const admin = fs.readFileSync(path.join(pub, 'admin.html'), 'utf8');
  const cheer = admin.slice(admin.indexOf('id="cheer"'), admin.indexOf('id="data"'));
  assert.match(cheer, /not on a court/);
  assert.doesNotMatch(cheer, /West|East|Full/);
  assert.match(admin, /matched by date \+ hour \(not by court\)/);
  const adminJs = fs.readFileSync(path.join(pub, 'admin.js'), 'utf8');
  const note = adminJs.slice(adminJs.indexOf('Cheer is per hour'), adminJs.indexOf('Cheer is per hour') + 120);
  assert.match(note, /not a court/);
  assert.doesNotMatch(note, /both courts|West|East|Full/);
  const server = fs.readFileSync(path.join(repoRoot, 'src/server.ts'), 'utf8');
  const sql = server.slice(server.indexOf('const cheerSlots = (await pool.query'), server.indexOf("return { type: 'state', kind: 'schedule'"));
  assert.doesNotMatch(sql, /court/i);
  const view = server.slice(server.indexOf('function cheerView'), server.indexOf('function teamView'));
  assert.doesNotMatch(view, /court:/);
});

const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test"' : false;
let URL_ = '';
let db: typeof import('../src/db.js');
let season: typeof import('../src/seed-season.js');
let srv: ChildProcess | null = null;
const ADMIN = 'season-admin-pw';

before(async () => {
  if (skip) return;
  const u = new URL(BASE_URL);
  const name = u.pathname.slice(1) + '_season';
  u.pathname = '/' + name;
  URL_ = u.toString();
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.DATABASE_URL = URL_;
  process.env.TZ = 'America/Chicago';
  db = await import('../src/db.js');
  season = await import('../src/seed-season.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
after(async () => { srv?.kill(); await db?.pool.end(); });

const COLOR_KEYS = ['season_cheer_primary', 'season_cheer_secondary', 'season_dark', 'season_light', 'season_name'];

test('dry-run writes nothing, a mid-import failure rolls back, two real imports match', { skip, timeout: 180_000 }, async () => {
  await db.migrate();
  const seededName = (await db.pool.query(`SELECT value FROM settings WHERE key = 'season_name'`)).rows[0].value as string;
  assert.equal(seededName, '2026\u201327 Upward');
  await db.pool.query(`INSERT INTO settings(key, value) VALUES
    ('season_dark', '#112233'),
    ('season_light', '#AABBCC'),
    ('season_cheer_primary', '#DDEEFF'),
    ('season_cheer_secondary', '#001122')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await db.pool.query(`INSERT INTO courts(slug, name, location, conflicts_with) VALUES
    ('full','Full','Main gym','{west,east}'), ('west','West','Main gym','{}'), ('east','East','Main gym','{}')
    ON CONFLICT (slug) DO NOTHING`);
  const home = (await db.pool.query(`INSERT INTO teams(name, short_name, grade, grade_order, gender, coach) VALUES ('Sentinel Home','SEN','5th-6th Grade',5,'Boys','Pat') RETURNING id`)).rows[0].id;
  const away = (await db.pool.query(`INSERT INTO teams(name, short_name, grade, grade_order, gender) VALUES ('Sentinel Away','SAW','5th-6th Grade',5,'Boys') RETURNING id`)).rows[0].id;
  await db.pool.query(`INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, division, duration_min)
    VALUES ((SELECT id FROM courts WHERE slug='west'), $1, $2, '2030-01-04 09:00:00-06', '5th-6th Grade Boys', 60)`, [home, away]);

  const colors = async () => (await db.pool.query(`SELECT key, value FROM settings WHERE key = ANY($1) ORDER BY key`, [COLOR_KEYS])).rows.map((r: { key: string; value: string }) => `${r.key}=${r.value}`).join('\n');
  const sentinel = async () => Number((await db.pool.query(`SELECT count(*)::int AS n FROM teams WHERE name LIKE 'Sentinel%'`)).rows[0].n);
  const gameCount = async () => Number((await db.pool.query('SELECT count(*)::int AS n FROM games')).rows[0].n);
  const beforeColors = await colors();
  assert.equal(await sentinel(), 2);
  assert.equal(await gameCount(), 1);

  const dry = await season.seedSeason({ dryRun: true });
  assert.match(dry.report, /DRY RUN: rolled back, nothing written/);
  assert.match(dry.report, /Kindergarten: 6 teams, 24 games/);
  assert.match(dry.report, /Total: 52 teams, 208 games/);
  assert.equal(dry.committed, false);
  assert.equal(dry.logos, undefined);
  assert.equal(await sentinel(), 2);
  assert.equal(await gameCount(), 1);
  assert.equal(await colors(), beforeColors);

  await assert.rejects(() => season.seedSeason({ files: badFiles }), /game schedule is missing column/);
  assert.equal(await sentinel(), 2, 'a bad CSV never starts the delete');
  assert.equal(await gameCount(), 1);

  await assert.rejects(() => season.seedSeason({}), (e: Error) => e instanceof season.SeasonRefusedError && /--reset/.test(e.message));
  assert.equal(await sentinel(), 2);
  assert.equal(await gameCount(), 1);

  await assert.rejects(() => season.seedSeason({ reset: true, injectError: 'boom-mid-import' }), /boom-mid-import/);
  assert.equal(await sentinel(), 2, 'a failure after the delete rolls back');
  assert.equal(await gameCount(), 1);
  assert.equal(await colors(), beforeColors);

  const first = await season.seedSeason({ reset: true });
  assert.equal(first.committed, true);
  assert.match(first.report, /IMPORTED/);
  assert.match(first.logos || '', /teams: matched/);
  console.log('SEASON_LOGOS\n' + first.logos);
  console.log('SEASON_WARNINGS\n' + plan.warnings.join('\n'));
  assert.equal(await sentinel(), 0);
  assert.equal(await gameCount(), 208);
  assert.equal(await colors(), beforeColors);
  const rules = Number((await db.pool.query(`SELECT count(*)::int AS n FROM games WHERE (rules->>'periodLengthMs')::int = 360000 AND (rules->>'periods')::int = 6 AND duration_min = 60`)).rows[0].n);
  assert.equal(rules, 208);
  assert.equal(Number((await db.pool.query('SELECT count(*)::int AS n FROM game_events')).rows[0].n), 0);
  assert.equal(Number((await db.pool.query(`SELECT count(*)::int AS n FROM teams WHERE coach IS NULL`)).rows[0].n), 4);
  const nullNames = (await db.pool.query(`SELECT name FROM teams WHERE coach IS NULL ORDER BY name`)).rows.map((r: { name: string }) => r.name);
  assert.deepEqual(nullNames, ['Bobcats', 'Buckeyes', 'Raiders', 'Wolfpack']);
  const shotA = await season.seasonSnapshot(db.pool);

  const second = await season.seedSeason({});
  assert.equal(second.committed, true);
  const shotB = await season.seasonSnapshot(db.pool);
  assert.deepEqual(shotB, shotA);
  assert.equal(await colors(), beforeColors);
  assert.equal(await gameCount(), 208);

  const started = await startServer({ DATABASE_URL: URL_, ADMIN_PASSWORD: ADMIN, TZ: 'America/Chicago', SEED: '' });
  srv = started.srv;
  const BASE = `http://127.0.0.1:${started.port}`;
  const api = async (p: string, method = 'GET', body?: unknown) => {
    const r = await fetch(BASE + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let b: any;
    try { b = JSON.parse(t); } catch { b = t; }
    return { status: r.status, body: b };
  };
  let token = '';
  token = (await api('/api/login', 'POST', { password: ADMIN })).body.token;
  assert.ok(token);
  const warnings = await api('/api/warnings');
  assert.deepEqual(warnings.body, [], JSON.stringify(warnings.body));
  console.log('SEASON_API_WARNINGS', Array.isArray(warnings.body) ? warnings.body.length : warnings.body);

  const sched = await api('/api/public/schedule?date=2027-01-16');
  assert.equal(sched.status, 200);
  assert.ok(sched.body.cheerSlots.length > 0);
  for (const s of sched.body.cheerSlots) {
    assert.equal(Object.hasOwn(s, 'court'), false);
    assert.equal(s.court, undefined);
  }

  const boys = (await db.pool.query(`SELECT id FROM teams WHERE grade = '5th-6th Grade' AND gender = 'Boys' ORDER BY name LIMIT 2`)).rows;
  const west = (await db.pool.query(`SELECT id FROM courts WHERE slug = 'west'`)).rows[0].id;
  const created = await api('/api/games', 'POST', { court_id: west, home_team_id: boys[0].id, away_team_id: boys[1].id, division: '5th-6th Grade Boys' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const go = await api(`/api/games/${created.body.id}/start`, 'POST', {});
  assert.equal(go.status, 200, JSON.stringify(go.body));
  const live = await api('/api/public/court/west');
  const st = live.body.game.state;
  assert.equal(st.clock.remainingMs, 360_000);
  assert.equal(st.clock.running, false);
  assert.equal(st.period, 1);
  assert.equal(st.rules.periods, 6);
  assert.equal(st.rules.periodLengthMs, 360_000);
  assert.equal(periodsPerHalf(st.rules), 3);
  assert.equal(st.banner, null);
  const cmd = (c: unknown) => new Promise<any>((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${started.port}/ws?court=west&role=score`, { headers: { authorization: `Bearer ${token}` } });
    const id = 'c' + Math.random();
    ws.on('open', () => ws.send(JSON.stringify({ type: 'cmd', id, cmd: c })));
    ws.on('message', (m) => { const j = JSON.parse(String(m)); if (j.id === id && (j.type === 'ack' || j.type === 'error')) { ws.close(); res(j); } });
    ws.on('error', rej);
  });
  for (let i = 0; i < 3; i++) assert.equal((await cmd({ type: 'PERIOD', delta: 1 })).type, 'ack');
  const half = (await api('/api/public/court/west')).body.game.state;
  assert.equal(half.period, 4);
  assert.equal(half.banner, 'HALFTIME');
  assert.equal(half.clock.remainingMs, 360_000);
});

test('startup SEED=demo never replaces a loaded real season (season_data marker)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');
  const seed = fs.readFileSync(path.join(root, 'src/seed-season.ts'), 'utf8');
  assert.match(seed, /'season_data', '2027'/);
  assert.match(server, /key = 'season_data'/);
  assert.ok(server.indexOf("key = 'season_data'") < server.indexOf("seedDemo('if-needed')"));
});
