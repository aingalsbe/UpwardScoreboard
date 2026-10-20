// Demo seed: locker rooms + coaches (pure plan, no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoSeedPlan, hourSlot, slotRooms, slotSeed, DEMO_ROOMS } from '../src/schedule.js';

test('demo seed: every game/team/cheer slot has a locker + coach; no room twice per slot (date + hour, all courts)', () => {
  const plan = demoSeedPlan({ fri: '2026-10-23', sat: '2026-10-24' });
  const slots = new Map<string, string[]>();
  for (const g of plan) {
    for (const v of [g.homeLocker, g.awayLocker]) assert.ok(DEMO_ROOMS.includes(v), `game ${g.date} ${g.time} ${g.court}: locker "${v}"`);
    assert.ok(g.homeCoach && g.awayCoach, 'team coaches');
    if (g.cheer) { assert.ok(g.cheerCoach, 'cheer coach'); assert.ok(DEMO_ROOMS.includes(g.cheerLocker!), 'cheer slot locker'); }
    const k = `${g.date} ${hourSlot(g.time)}`;
    slots.set(k, [...(slots.get(k) || []), g.homeLocker, g.awayLocker, ...(g.cheer ? [g.cheerLocker!] : [])]);
  }
  for (const [k, rooms] of slots) assert.equal(new Set(rooms).size, rooms.length, `slot ${k}: rooms ${rooms.join(',')}`);
  const coaches = plan.flatMap((g) => [g.homeCoach, g.awayCoach, ...(g.cheerCoach ? [g.cheerCoach] : [])]);
  assert.equal(new Set(coaches).size, coaches.length, 'every coach first name is different');
  assert.deepEqual(demoSeedPlan({ fri: '2026-10-23', sat: '2026-10-24' }), plan, 'deterministic');
});

test('slotRooms: skips taken rooms, deterministic rotation', () => {
  assert.deepEqual(slotRooms([], 3, 0), ['CH', '1', '2']);
  assert.deepEqual(slotRooms(['1', null], 3, 0), ['CH', '2', '3']);
  assert.deepEqual(slotRooms([], 2, 8), ['1', '2']);
  assert.equal(slotSeed('2026-10-24', '09:00'), slotSeed('2026-10-24', '09:00'));
});
