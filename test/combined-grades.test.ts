import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  GRADES, DIVISIONS, BOYS, GIRLS, normalizeGrade, normalizeDivision, divisionLabel, gradeOrder, isScoreHiddenGrade, demoSeedPlan,
} from '../src/schedule.js';
import { hidesScore } from '../src/payload.js';
import { readManifest } from '../src/logo-files.js';

test('combined grade bands: 4 canonical grades and 7 divisions (Kindergarten mixed)', () => {
  assert.deepEqual(GRADES, ['Kindergarten', '1st-2nd Grade', '3rd-4th Grade', '5th-6th Grade']);
  assert.deepEqual(DIVISIONS, [
    'Kindergarten',
    '1st-2nd Grade Boys',
    '1st-2nd Grade Girls',
    '3rd-4th Grade Boys',
    '3rd-4th Grade Girls',
    '5th-6th Grade Boys',
    '5th-6th Grade Girls',
  ]);
  for (const k of ['K', 'k', 'kg', 'kinder', 'Kindergarten', 'Kindergarten Grade', 'Kindergarten Boys', 'Kindergarten Girls', 'K Boys', 'K Girls']) {
    assert.equal(normalizeGrade(k), 'Kindergarten', k);
  }
  for (const g12 of ['1', '1st', '1st Grade', 'Grade 1', 'First', 'First Grade', '2', '2nd', '2nd Grade', 'Grade 2', 'Second', 'Second Grade', '1-2', '1-2nd', '1st-2nd', '1st–2nd', '1st/2nd', '1st-2nd Grade', 'Grades 1-2']) {
    assert.equal(normalizeGrade(g12), '1st-2nd Grade', g12);
  }
  for (const g34 of ['3', '3rd', '3rd Grade', 'Grade 3', 'Third', '4', '4th', '4th Grade', 'Grade 4', 'Fourth', '3-4', '3-4th', '3rd-4th', '3rd–4th', '3rd/4th', '3rd-4th Grade', 'Grades 3-4']) {
    assert.equal(normalizeGrade(g34), '3rd-4th Grade', g34);
  }
  for (const g56 of ['5', '5th', '5th Grade', 'Grade 5', 'Fifth', '6', '6th', '6th Grade', 'Grade 6', 'Sixth', '5-6', '5-6th', '5-6th Grade', '5th-6th', '5th–6th', '5th/6th', '5th-6th Grade', 'Grades 5-6']) {
    assert.equal(normalizeGrade(g56), '5th-6th Grade', g56);
  }
  assert.equal(divisionLabel('Kindergarten', null), 'Kindergarten');
  assert.equal(divisionLabel('Kindergarten', 'Boys'), 'Kindergarten');
  assert.equal(divisionLabel('Kindergarten', 'Girls'), 'Kindergarten');
  assert.equal(normalizeDivision('Kindergarten Boys'), 'Kindergarten');
  assert.equal(normalizeDivision('2nd Grade Boys'), '1st-2nd Grade Boys');
  assert.equal(normalizeDivision('3rd Grade Girls'), '3rd-4th Grade Girls');
  assert.equal(normalizeDivision('6th Grade Boys'), '5th-6th Grade Boys');
  assert.equal(normalizeDivision('Renamed 123'), 'Renamed 123');
});

test('K-2nd score-hiding rule: Kindergarten and 1st-2nd Grade hide scores; 3rd-4th and 5th-6th show scores', () => {
  for (const g of ['Kindergarten', '1st-2nd Grade']) {
    assert.equal(isScoreHiddenGrade(g), true, `${g} isScoreHiddenGrade`);
    assert.equal(hidesScore(gradeOrder(g)), true, `${g} hidesScore(gradeOrder)`);
  }
  for (const g of ['3rd-4th Grade', '5th-6th Grade']) {
    assert.equal(isScoreHiddenGrade(g), false, `${g} isScoreHiddenGrade`);
    assert.equal(hidesScore(gradeOrder(g)), false, `${g} hidesScore(gradeOrder)`);
  }
});

test('Girls teams carry the "Lady " prefix across GIRLS pool, demoSeedPlan, generated CSVs, and manifest.json', () => {
  assert.equal(GIRLS.length, 12);
  assert.equal(BOYS.length, 12);
  for (const g of GIRLS) assert.match(g, /^Lady [A-Z]/, g);
  const plan = demoSeedPlan({ fri: '2026-10-16', sat: '2026-10-17' });
  const divs = new Set(plan.map((g) => divisionLabel(g.grade, g.gender)));
  assert.deepEqual([...divs].sort(), [...DIVISIONS].sort());
  for (const g of plan) {
    if (g.grade === 'Kindergarten') assert.equal(g.gender, null);
    if (g.gender === 'Girls') {
      assert.match(g.home, /^Lady /);
      assert.match(g.away, /^Lady /);
    }
  }
  if (fs.existsSync('samples/teams.csv')) {
    const lines = fs.readFileSync('samples/teams.csv', 'utf8').trim().split('\n').slice(1);
    assert.equal(lines.length, 44);
    for (const line of lines) {
      const [name, short, grade, gender] = line.split(',');
      if (grade === 'Kindergarten') assert.equal(gender, '');
      if (gender === 'Girls') {
        assert.match(name, /^Lady /);
        assert.notEqual(short, 'LAD', `${name} short_name should use mascot, not LAD`);
      }
    }
  }
  // Every entry in manifest.json points to a PNG whose filename ends with -<mascot>.png
  const man = readManifest();
  for (const e of man.teams) {
    const mascot = (e as any).mascot ? String((e as any).mascot).toLowerCase() : e.name.replace(/^Lady\s+/i, '').toLowerCase();
    assert.ok(e.file.endsWith(`-${mascot}.png`), `${e.division} | ${e.name} should point to *-${mascot}.png, got ${e.file}`);
  }
});

import pg from 'pg';
const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skipDb = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test"' : false;

test('DB: migrateCombinedGrades normalizes legacy grades, resolves merged-grade and lower-id->higher-id collisions, clears stale built-in logos on rename, and refreshes logos', { skip: skipDb }, async () => {
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_cgrades'; u.pathname = '/' + name;
  const admin = new pg.Client({ connectionString: BASE_URL }); await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.DATABASE_URL = u.toString(); process.env.TZ = 'America/Chicago';
  const db = await import('../src/db.js');
  const lf = await import('../src/logo-files.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();

  // Case A: Standard legacy single-grade teams including a 3rd+4th collision and unprefixed Girls teams + Kindergarten with gender
  await db.pool.query(`INSERT INTO teams(name, short_name, grade, grade_order, gender, logo_url) VALUES
    ('Bearcats', 'BEA', '3rd Grade', 3, 'Girls', NULL),
    ('Bearcats', 'BEA', '4th Grade', 4, 'Girls', '/team-logos/teams/4th-grade-girls-stars.png'),
    ('Huskies', 'HUS', '2nd Grade', 2, 'Girls', NULL),
    ('Cubs', 'CUB', 'Kindergarten', 0, 'Boys', NULL)`);
  const c1 = (await db.pool.query(`SELECT id FROM teams WHERE grade='3rd Grade'`)).rows[0].id;
  const c2 = (await db.pool.query(`SELECT id FROM teams WHERE grade='4th Grade'`)).rows[0].id;
  await db.pool.query(`INSERT INTO games(home_team_id, away_team_id, division) VALUES ($1, $2, '3rd Grade Girls')`, [c1, c2]);

  const n = await db.migrateCombinedGrades();
  assert.ok(n > 0);
  const { rows: trows } = await db.pool.query(`SELECT name, short_name, grade, grade_order, gender, logo_url FROM teams ORDER BY id`);
  assert.equal(trows[0].name, 'Lady Bearcats');
  assert.equal(trows[0].short_name, 'BEA');
  assert.equal(trows[0].grade, '3rd-4th Grade');
  assert.equal(trows[0].grade_order, 3);
  assert.equal(trows[0].gender, 'Girls');
  // Second Bearcats (was 4th Grade Girls) merged into 3rd-4th Grade Girls, got a non-colliding Lady name, and had its stale stars.png logo replaced with its new mascot logo
  assert.match(trows[1].name, /^Lady /);
  assert.notEqual(trows[1].name, 'Lady Bearcats');
  assert.equal(trows[1].grade, '3rd-4th Grade');
  const newMascot1 = trows[1].name.replace(/^Lady\s+/i, '').toLowerCase();
  assert.ok(trows[1].logo_url?.endsWith(`-${newMascot1}.png`), `expected refreshed logo for ${trows[1].name}, got ${trows[1].logo_url}`);
  // Huskies -> Lady Huskies in 1st-2nd Grade Girls
  assert.equal(trows[2].name, 'Lady Huskies');
  assert.equal(trows[2].short_name, 'HUS');
  assert.equal(trows[2].grade, '1st-2nd Grade');
  assert.equal(trows[2].grade_order, 2);
  // Kindergarten Boys -> Kindergarten with gender null
  assert.equal(trows[3].grade, 'Kindergarten');
  assert.equal(trows[3].gender, null);
  // games.division normalized
  const gdiv = (await db.pool.query(`SELECT division FROM games LIMIT 1`)).rows[0].division;
  assert.equal(gdiv, '3rd-4th Grade Girls');
  // Idempotent on second run
  assert.equal(await db.migrateCombinedGrades(), 0);

  // Case B: All 3 exact lower-id -> higher-id 23505 collision repros from Avery P1
  await db.pool.query(`DELETE FROM games; DELETE FROM teams;`);
  await db.pool.query(`INSERT INTO teams(name, short_name, grade, grade_order, gender) VALUES
    ('Eagles', 'EAG', 'Kindergarten', 0, 'Boys'),
    ('Eagles', 'EAG', 'Kindergarten', 0, NULL),
    ('Eagles', 'EAG', '3rd Grade', 3, 'Boys'),
    ('Eagles', 'EAG', '3rd-4th Grade', 3, 'Boys'),
    ('Stars', 'STA', '1st-2nd Grade', 2, 'Girls'),
    ('Lady Stars', 'STA', '1st-2nd Grade', 2, 'Girls')`);
  const n2 = await db.migrateCombinedGrades();
  assert.ok(n2 >= 3);
  const { rows: r2 } = await db.pool.query(`SELECT id, name, short_name, grade, gender FROM teams ORDER BY id`);
  assert.equal(r2.length, 6);
  // Higher-id rows that were ALREADY at their canonical (grade, gender, name) kept their names; lower-id rows migrating into them were renamed without throwing 23505
  assert.equal(r2[1].name, 'Eagles'); assert.equal(r2[1].grade, 'Kindergarten'); assert.equal(r2[1].gender, null);
  assert.notEqual(r2[0].name, 'Eagles'); assert.equal(r2[0].grade, 'Kindergarten'); assert.equal(r2[0].gender, null);
  assert.equal(r2[3].name, 'Eagles'); assert.equal(r2[3].grade, '3rd-4th Grade'); assert.equal(r2[3].gender, 'Boys');
  assert.notEqual(r2[2].name, 'Eagles'); assert.equal(r2[2].grade, '3rd-4th Grade'); assert.equal(r2[2].gender, 'Boys');
  assert.equal(r2[5].name, 'Lady Stars'); assert.equal(r2[5].grade, '1st-2nd Grade'); assert.equal(r2[5].gender, 'Girls');
  assert.match(r2[4].name, /^Lady /); assert.notEqual(r2[4].name, 'Lady Stars'); assert.equal(r2[4].grade, '1st-2nd Grade'); assert.equal(r2[4].gender, 'Girls');

  // Case C: Migrating a full 44-team legacy (f6c4bc1) database preserves 44/44 logos with 0 unmatched and 0 withoutLogo
  await db.pool.query(`DELETE FROM games; DELETE FROM teams; DELETE FROM cheer_squads;`);
  const legGrades: [string, number, 'Boys' | 'Girls', string[]][] = [
    ['2nd Grade', 2, 'Boys', ['Eagles', 'Lions', 'Bears', 'Hawks', 'Tigers', 'Rams']],
    ['2nd Grade', 2, 'Girls', ['Stars', 'Comets', 'Lightning', 'Sparks', 'Hornets', 'Cardinals']],
    ['3rd Grade', 3, 'Boys', ['Eagles', 'Lions', 'Bears', 'Hawks', 'Tigers', 'Rams']],
    ['3rd Grade', 3, 'Girls', ['Stars', 'Comets', 'Lightning', 'Sparks', 'Hornets', 'Cardinals']],
    ['4th Grade', 4, 'Boys', ['Eagles', 'Lions', 'Bears', 'Hawks']],
    ['4th Grade', 4, 'Girls', ['Stars', 'Comets', 'Lightning', 'Sparks']],
    ['5th Grade', 5, 'Boys', ['Eagles', 'Lions']],
    ['5th Grade', 5, 'Girls', ['Stars', 'Comets', 'Lightning', 'Sparks']],
    ['6th Grade', 6, 'Boys', ['Eagles', 'Lions', 'Bears', 'Hawks']],
    ['6th Grade', 6, 'Girls', ['Stars', 'Comets']],
  ];
  for (const [gr, go, ge, names] of legGrades) {
    for (const nm of names) {
      const slug = `${gr.toLowerCase().replace(/\s+/g, '-')}-${ge.toLowerCase()}-${nm.toLowerCase()}.png`;
      await db.pool.query(
        `INSERT INTO teams(name, short_name, grade, grade_order, gender, logo_url) VALUES ($1, $2, $3, $4, $5, $6)`,
        [nm, nm.slice(0, 3).toUpperCase(), gr, go, ge, `/team-logos/teams/${slug}`]
      );
    }
  }
  await db.migrateCombinedGrades();
  const rep = await lf.loadLogos(db.pool);
  assert.equal(rep.teams.matched, 44);
  assert.deepEqual(rep.teams.withoutLogo, []);
  const { rows: migTeams } = await db.pool.query(`SELECT name, grade, gender, logo_url FROM teams ORDER BY id`);
  for (const t of migTeams) {
    const mSlug = t.name.replace(/^Lady\s+/i, '').toLowerCase();
    assert.ok(t.logo_url && t.logo_url.endsWith(`-${mSlug}.png`), `${t.grade} ${t.gender} ${t.name} has matching mascot logo (${t.logo_url})`);
  }

  await db.pool.end();
});

import { startServer } from './_server.js';

test('API: POST /api/teams, PUT /api/teams/:id, and POST /api/import/teams.csv auto-prepend "Lady " on Girls teams and derive mascot short_name', { skip: skipDb }, async () => {
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_cgrades_api'; u.pathname = '/' + name;
  const admin = new pg.Client({ connectionString: BASE_URL }); await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const started = await startServer({ DATABASE_URL: u.toString(), ADMIN_PASSWORD: 'test-password', TZ: 'America/Chicago', SEED: '' });
  const BASE = `http://127.0.0.1:${started.port}`;
  try {
    const login = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
    const cookie = login.headers.get('set-cookie') || '';
    const api = async (p: string, opts: any = {}) => {
      const r = await fetch(BASE + p, { ...opts, headers: { cookie, 'content-type': 'application/json', ...(opts.headers || {}) } });
      return { status: r.status, body: await r.json() };
    };
    // 1. POST /api/teams with gender=Girls and unprefixed name -> auto-prepends "Lady " and derives short_name from mascot
    const r1 = await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'Mustangs', grade: '3rd-4th Grade', gender: 'Girls' }) });
    assert.equal(r1.status, 201);
    let teams = (await api('/api/teams')).body;
    const t1 = teams.find((t: any) => t.id === r1.body.id);
    assert.equal(t1.name, 'Lady Mustangs');
    assert.equal(t1.short_name, 'MUS');
    assert.equal(t1.grade, '3rd-4th Grade');
    assert.equal(t1.gender, 'Girls');

    // 2. POST /api/teams with already-prefixed "Lady Doves" -> does not double-prefix
    const r2 = await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'lady Doves', grade: '3rd-4th Grade', gender: 'Girls' }) });
    assert.equal(r2.status, 201);
    teams = (await api('/api/teams')).body;
    const t2 = teams.find((t: any) => t.id === r2.body.id);
    assert.equal(t2.name, 'lady Doves');
    assert.equal(t2.short_name, 'DOV');

    // 3. PUT /api/teams/:id changing a team to Girls -> auto-prepends "Lady "
    const r3 = await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'Wildcats', grade: '1st-2nd Grade', gender: 'Boys' }) });
    assert.equal(r3.status, 201);
    const u3 = await api(`/api/teams/${r3.body.id}`, { method: 'PUT', body: JSON.stringify({ name: 'Wildcats', grade: '1st-2nd Grade', gender: 'Girls' }) });
    assert.equal(u3.status, 200);
    teams = (await api('/api/teams')).body;
    const t3 = teams.find((t: any) => t.id === r3.body.id);
    assert.equal(t3.name, 'Lady Wildcats');
    assert.equal(t3.short_name, 'WIL');

    // 4. POST /api/import/teams.csv with gender=Girls -> auto-prepends "Lady " and matches idempotently on re-import
    const csv = `name,short_name,grade,gender\nBluebirds,,5th-6th Grade,Girls\nMustangs,MUS,3rd-4th Grade,Girls\n`;
    const imp = await api('/api/import/teams.csv', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: csv });
    assert.equal(imp.status, 200);
    assert.equal(imp.body.created, 1);
    assert.equal(imp.body.skipped, 1);
    teams = (await api('/api/teams')).body;
    const tb = teams.find((t: any) => t.grade === '5th-6th Grade' && t.gender === 'Girls');
    assert.equal(tb.name, 'Lady Bluebirds');
    assert.equal(tb.short_name, 'BLU');
  } finally {
    started.srv.kill();
  }
});
