import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  GRADES, DIVISIONS, BOYS, GIRLS, normalizeGrade, normalizeDivision, divisionLabel, gradeOrder, isScoreHiddenGrade, demoSeedPlan,
} from '../src/schedule.js';
import { hidesScore } from '../src/payload.js';

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

test('Girls teams carry the "Lady " prefix across GIRLS pool, demoSeedPlan, and generated CSVs', () => {
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
});

import pg from 'pg';
const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skipDb = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test"' : false;

test('DB: migrateCombinedGrades normalizes legacy grades, resolves merged-grade collisions, prefixes Lady on Girls teams, and clears Kindergarten gender', { skip: skipDb }, async () => {
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_cgrades'; u.pathname = '/' + name;
  const admin = new pg.Client({ connectionString: BASE_URL }); await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.DATABASE_URL = u.toString(); process.env.TZ = 'America/Chicago';
  const db = await import('../src/db.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
  // Insert legacy single-grade teams including a 3rd+4th collision and unprefixed Girls teams + Kindergarten with gender
  await db.pool.query(`INSERT INTO teams(name, short_name, grade, grade_order, gender) VALUES
    ('Bearcats', 'BEA', '3rd Grade', 3, 'Girls'),
    ('Bearcats', 'BEA', '4th Grade', 4, 'Girls'),
    ('Huskies', 'HUS', '2nd Grade', 2, 'Girls'),
    ('Cubs', 'CUB', 'Kindergarten', 0, 'Boys')`);
  const c1 = (await db.pool.query(`SELECT id FROM teams WHERE grade='3rd Grade'`)).rows[0].id;
  const c2 = (await db.pool.query(`SELECT id FROM teams WHERE grade='4th Grade'`)).rows[0].id;
  await db.pool.query(`INSERT INTO games(home_team_id, away_team_id, division) VALUES ($1, $2, '3rd Grade Girls')`, [c1, c2]);

  const n = await db.migrateCombinedGrades();
  assert.ok(n > 0);
  const { rows: trows } = await db.pool.query(`SELECT name, short_name, grade, grade_order, gender FROM teams ORDER BY id`);
  assert.equal(trows[0].name, 'Lady Bearcats');
  assert.equal(trows[0].short_name, 'BEA');
  assert.equal(trows[0].grade, '3rd-4th Grade');
  assert.equal(trows[0].grade_order, 3);
  assert.equal(trows[0].gender, 'Girls');
  // Second Bearcats (was 4th Grade Girls) merged into 3rd-4th Grade Girls and got a non-colliding Lady name
  assert.match(trows[1].name, /^Lady /);
  assert.notEqual(trows[1].name, 'Lady Bearcats');
  assert.equal(trows[1].grade, '3rd-4th Grade');
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
  await db.pool.end();
});
