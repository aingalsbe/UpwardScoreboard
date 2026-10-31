import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourSlot, slotStartMin, cheerSlotWarnings, scheduleWarnings, WarnGame } from '../src/schedule.js';
import { scorekeeperView, stripCoaches, hasCoachKey } from '../src/payload.js';

test('hour-slot bucketing: a game belongs to the slot its start falls in', () => {
  assert.equal(hourSlot('09:00'), '09:00');
  assert.equal(hourSlot('09:05'), '09:00');
  assert.equal(hourSlot('9:59'), '09:00');
  assert.equal(hourSlot('10:00'), '10:00');
  assert.equal(hourSlot('17:30'), '17:00');
  assert.equal(hourSlot('00:00:00'), '00:00');
  assert.throws(() => hourSlot('24:00')); assert.throws(() => hourSlot('9')); assert.throws(() => hourSlot(''));
  assert.equal(slotStartMin(9 * 60 + 5), 9 * 60); assert.equal(slotStartMin(10 * 60), 10 * 60);
});

const G = (id: number, date: string, hm: string, court = 'west', grade = '2nd Grade', cheer: string | null = null): WarnGame => {
  const [h, m] = hm.split(':').map(Number);
  return { id, date, startMin: h * 60 + m, durMin: 60, court, grade, label: grade, homeId: id * 10, awayId: id * 10 + 1, home: `H${id}`, away: `A${id}`, hasCheer: !!cheer, cheer };
};

test('cheer-slot-empty: a slot whose hour has no games (09:05 counts for the 09:00 slot)', () => {
  const games = [G(1, '2026-10-24', '09:05'), G(2, '2026-10-24', '10:00')];
  const w = cheerSlotWarnings([{ date: '2026-10-24', start: '09:00', squad: 'Pep' }, { date: '2026-10-24', start: '11:00', squad: 'Joy' }], games, []);
  assert.deepEqual(w.map((x) => [x.code, x.slot?.start, x.gameId]), [['cheer-slot-empty', '11:00', null]]);
});

test('cheer-slot-conflict lists the candidate squads', () => {
  const w = cheerSlotWarnings([], [], [{ date: '2026-10-24', start: '10:00', candidates: ['Pep Power', 'Sparkle'] }]);
  assert.equal(w.length, 1); assert.equal(w[0].code, 'cheer-slot-conflict');
  assert.deepEqual(w[0].candidates, ['Pep Power', 'Sparkle']); assert.match(w[0].message, /Pep Power, Sparkle/);
});

test('cheer grade/day rule is checked for every game in a cheer slot', () => {
  // Saturday 2026-10-24: 2nd West and 5th Full (including 5 PM) are allowed. Friday is not.
  const w = scheduleWarnings([
    G(1, '2026-10-24', '09:00', 'west', '2nd Grade', 'Pep'),
    G(2, '2026-10-24', '17:00', 'full', '5th Grade', 'Pep'),
    G(3, '2026-10-23', '18:00', 'full', '3rd Grade', 'Pep'),
  ]);
  const c = w.filter((x) => x.code === 'cheer-not-allowed');
  assert.deepEqual(c.map((x) => x.gameId), [3]);
  assert.match(c[0].message, /Saturday/);
  assert.match(c[0].message, /cheer slot at 18:00 \(Pep\)/);
});

const payload = () => ({
  type: 'state', court: { slug: 'west' },
  game: { id: 1, home: { name: 'Knights', locker: 'CH', coach: 'Mike' }, away: { name: 'Mustangs', locker: '5', coach: 'Sarah' }, cheer: { name: 'Pep', coach: 'Amy', locker: '1' } },
  upNext: [{ id: 2, home: 'A', away: 'B', coach: 'X', nested: [{ coach: 'Y', deeper: { coach: 'Z' } }] }],
  today: [{ id: 3, home_locker: '2' }],
});

test('scorekeeper payload: deep scan finds no coach key anywhere, and no cheer data', () => {
  const p = payload();
  assert.equal(hasCoachKey(p), true);
  const s = scorekeeperView(p);
  assert.equal(hasCoachKey(s), false, JSON.stringify(s));
  assert.equal('cheer' in s.game, false);
  assert.equal(s.game.home.locker, 'CH'); // lockers may be shown; only coaches are banned
  assert.equal(s.today[0].home_locker, '2');
  assert.equal(hasCoachKey(p), true, 'input is not mutated');
  assert.equal(hasCoachKey(JSON.parse(JSON.stringify(scorekeeperView({ type: 'time', coach: 'x' })))), false);
  assert.deepEqual(stripCoaches([1, 'a', null, { coach: 1, b: 2 }]), [1, 'a', null, { b: 2 }]);
});
