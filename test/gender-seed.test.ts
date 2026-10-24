import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeGender, genderMismatch, divisionLabel, scheduleWarnings, demoWeekend, demoSeedPlan, resolveScheduleDay, dayLabel, dowOf, gradeOrder, WarnGame,
} from '../src/schedule.js';

const CT = (iso: string) => Date.parse(iso); // instants; tz math is done with America/Chicago below

test('gender normalizes, labels and must match within a game', () => {
  assert.equal(normalizeGender('girls'), 'Girls'); assert.equal(normalizeGender('B'), 'Boys'); assert.equal(normalizeGender(' '), null);
  assert.throws(() => normalizeGender('coed'), /Boys or Girls/);
  assert.equal(divisionLabel('3rd-4th Grade', 'Girls'), '3rd-4th Grade Girls');
  assert.equal(divisionLabel('3rd-4th Grade', null), '3rd-4th Grade');
  assert.equal(divisionLabel('Kindergarten', 'Boys'), 'Kindergarten');
  assert.equal(divisionLabel('Kindergarten', null), 'Kindergarten');
  assert.match(genderMismatch({ name: 'Eagles', gender: 'Boys' }, { name: 'Lady Stars', gender: 'Girls' })!, /one gender/);
  assert.equal(genderMismatch({ name: 'A', gender: 'Boys' }, { name: 'B', gender: null }), null); // legacy team without gender
  assert.match(genderMismatch({ name: 'A', gender: 'Boys' }, { name: 'B', gender: 'Boys' }, 'Girls')!, /doesn't match/);
});

test('demo weekend is the upcoming Fri/Sat, or the current one on Fri/Sat (America/Chicago)', () => {
  const tz = 'America/Chicago';
  assert.deepEqual(demoWeekend(CT('2026-10-14T15:00:00Z'), tz), { fri: '2026-10-16', sat: '2026-10-17' }); // Wed
  assert.deepEqual(demoWeekend(CT('2026-10-16T15:00:00Z'), tz), { fri: '2026-10-16', sat: '2026-10-17' }); // Fri
  assert.deepEqual(demoWeekend(CT('2026-10-17T23:00:00Z'), tz), { fri: '2026-10-16', sat: '2026-10-17' }); // Sat evening CT
  assert.deepEqual(demoWeekend(CT('2026-10-18T04:30:00Z'), tz), { fri: '2026-10-16', sat: '2026-10-17' }); // Sat 23:30 CT (Sun UTC)
  assert.deepEqual(demoWeekend(CT('2026-10-18T15:00:00Z'), tz), { fri: '2026-10-23', sat: '2026-10-24' }); // Sun
  assert.equal(resolveScheduleDay({ day: 'sat' }, CT('2026-10-14T15:00:00Z'), tz), '2026-10-17');
  assert.equal(resolveScheduleDay({ date: '2026-11-07', day: 'fri' }, 0, tz), '2026-11-07');
  assert.equal(resolveScheduleDay({ date: '2026-02-31' }, CT('2026-10-14T15:00:00Z'), tz), '2026-10-14'); // invalid -> today
  assert.equal(dayLabel('2026-10-24'), 'Saturday, Oct 24');
});

test('demo seed invariants: counts, times, grades, genders, each team once, cheer rules', () => {
  const w = { fri: '2026-10-16', sat: '2026-10-17' }, plan = demoSeedPlan(w);
  const fri = plan.filter((g) => g.date === w.fri), sat = plan.filter((g) => g.date === w.sat);
  assert.deepEqual(fri.map((g) => `${g.court} ${g.time}`), ['full 17:30', 'full 18:30', 'full 19:30']);
  assert.deepEqual(sat.filter((g) => g.court === 'full').map((g) => g.time), ['16:30', '17:30', '18:30']);
  const split = sat.filter((g) => g.court !== 'full');
  assert.equal(split.length, 16);
  for (let h = 8; h <= 15; h++) { const t = `${String(h).padStart(2, '0')}:00`; assert.deepEqual(split.filter((g) => g.time === t).map((g) => g.court).sort(), ['east', 'west']); }
  // youngest first: Kindergarten (2), 1st-2nd Grade (4), 3rd-4th Grade (10)
  const order = split.map((g) => gradeOrder(g.grade)); assert.deepEqual([...order].sort((a, b) => a - b), order.slice().sort((a, b) => a - b));
  for (let i = 1; i < split.length; i++) assert.ok(gradeOrder(split[i].grade) >= gradeOrder(split[i - 1].grade), 'grades ascend through the day');
  assert.deepEqual(['Kindergarten', '1st-2nd Grade', '3rd-4th Grade'].map((g) => split.filter((x) => x.grade === g).length), [2, 4, 10]);
  // Kindergarten is mixed (gender null); numbered split slots have one Boys and one Girls game
  assert.deepEqual(split.filter((g) => g.time === '08:00').map((g) => g.gender), [null, null]);
  for (const t of new Set(split.filter((g) => g.time !== '08:00').map((g) => g.time))) assert.deepEqual(split.filter((g) => g.time === t).map((g) => g.gender).sort(), ['Boys', 'Girls']);
  const full = plan.filter((g) => g.court === 'full');
  assert.equal(full.length, 6); assert.ok(full.every((g) => g.grade === '5th-6th Grade'));
  assert.equal(full.filter((g) => g.gender === 'Boys').length, 3);
  assert.equal(full.filter((g) => g.gender === 'Girls').length, 3);
  // all Girls teams start with "Lady "
  for (const g of plan.filter((x) => x.gender === 'Girls')) {
    assert.match(g.home, /^Lady /); assert.match(g.away, /^Lady /);
  }
  // every team exactly once (team identity = grade + gender + name), 2 teams per game
  const keys = plan.flatMap((g) => [g.home, g.away].map((n) => `${g.grade}|${g.gender ?? ''}|${n}`));
  assert.equal(keys.length, plan.length * 2); assert.equal(new Set(keys).size, keys.length);
  // cheer squads only on some Saturday split games
  const cheer = plan.filter((g) => g.cheer);
  assert.ok(plan.every((g) => !('homeCheer' in g) && !('awayCheer' in g)), 'one squad per game, never per side');
  assert.ok(cheer.length > 0 && cheer.length < split.length);
  assert.ok(cheer.every((g) => g.date === w.sat && g.court !== 'full' && gradeOrder(g.grade) >= 0 && gradeOrder(g.grade) <= 4));
  assert.ok(dowOf(w.fri) === 5 && dowOf(w.sat) === 6);
});

test('the seeded schedule has no warnings; each rule warns', () => {
  const w = { fri: '2026-10-16', sat: '2026-10-17' };
  const toWarn = (g: ReturnType<typeof demoSeedPlan>[number], i: number): WarnGame => {
    const [h, m] = g.time.split(':').map(Number);
    return { id: i + 1, date: g.date, startMin: h * 60 + m, durMin: 60, court: g.court, grade: g.grade, label: divisionLabel(g.grade, g.gender),
      homeId: 1000 + i * 2, awayId: 1001 + i * 2, home: g.home, away: g.away, hasCheer: !!g.cheer };
  };
  const games = demoSeedPlan(w).map(toWarn);
  assert.deepEqual(scheduleWarnings(games), []);
  const base: WarnGame = { id: 1, date: '2026-10-17', startMin: 9 * 60, durMin: 60, court: 'west', grade: '3rd-4th Grade', label: '3rd-4th Grade Girls', homeId: 1, awayId: 2, home: 'Lady Stars', away: 'Lady Comets', hasCheer: false };
  const twice = scheduleWarnings([base, { ...base, id: 2, date: '2026-10-16', startMin: 18 * 60, court: 'full', awayId: 3, away: 'Lady Sparks' }]);
  assert.equal(twice.filter((x) => x.code === 'team-twice-weekend').length, 2); assert.match(twice[0].message, /Lady Stars plays 2 times this weekend/);
  assert.deepEqual(scheduleWarnings([base, { ...base, id: 2, date: '2026-10-24', homeId: 1, awayId: 9 }]), []); // next weekend: fine
  assert.equal(scheduleWarnings([{ ...base, startMin: 15 * 60 + 30 }])[0].code, 'split-outside-hours'); // ends 16:30
  assert.equal(scheduleWarnings([{ ...base, startMin: 7 * 60 }])[0].code, 'split-outside-hours');
  assert.deepEqual(scheduleWarnings([{ ...base, startMin: 15 * 60 }]), []); // 15:00–16:00 is fine
  assert.equal(scheduleWarnings([{ ...base, court: 'full', startMin: 9 * 60 }]).length, 0); // Full court: no hours rule
  assert.match(scheduleWarnings([{ ...base, hasCheer: true, grade: '5th-6th Grade' }])[0].message, /2nd–4th grade/);
  assert.match(scheduleWarnings([{ ...base, hasCheer: true, date: '2026-10-16' }])[0].message, /Saturday split-court/);
  assert.match(scheduleWarnings([{ ...base, hasCheer: true, court: 'full' }])[0].message, /Saturday split-court/);
  assert.deepEqual(scheduleWarnings([{ ...base, hasCheer: true }]), []);
});

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
// public/ is not copied into the Docker build stage; there this test is skipped (npm test runs it).
test('home team is listed first everywhere (markup order and text templates)', { skip: !fs.existsSync(PUB) && 'public/ not present (image build)' }, () => {
  const pub = PUB;
  const read = (f: string) => fs.readFileSync(path.join(pub, f), 'utf8');
  // DOM order: the home block comes before the away block on every board / list.
  for (const [f, home, away] of [['tv.html', 'class="team home"', 'class="team away"'], ['score.html', 'class="panel team home"', 'class="panel team away"'],
    ['overlay.html', 'class="side home"', 'class="side away"'], ['lobby.js', "teamRow(g, 'home'", "teamRow(g, 'away'"]]) {
    const s = read(f); assert.ok(s.indexOf(home) > -1 && s.indexOf(home) < s.indexOf(away), `${f}: home before away`);
  }
  // Text: no "away … vs … home" matchup and no away-score-first score line in any screen script.
  for (const f of ['display.js', 'score.js', 'admin.js', 'lobby.js']) {
    const s = read(f);
    assert.ok(!/away[\w.]*\}?\s*(?:vs|–)\s*\$\{[^}]*home/.test(s), `${f}: away listed before home`);
  }
});
