// Idle screens: next game day vs next practice night, whichever is first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const skip = !fs.existsSync(path.join(PUB, 'next-event.js')) && 'public/ not present';
const mod = () => import(path.join(PUB, 'next-event.js'));
const practice = {
  days: [{ day: 1, start: '17:00', end: '21:00' }, { day: 3, start: '16:30', end: '18:30' }],
  basketball: [{ day: 1 }, { day: 3 }], cheer: [{ day: 1 }],
};
// 2026-10-24 is a Saturday, 10-26 Monday, 10-28 Wednesday, 10-30 Friday.

test('game next: Friday games come before the following Monday practice', { skip }, async () => {
  const { nextEvent, nextEventText } = await mod();
  const ev = nextEvent({ today: '2026-10-29', now: '20:00', gameDays: [{ date: '2026-10-30', first: '17:30' }], practice });
  assert.deepEqual(ev, { type: 'game', date: '2026-10-30', time: '17:30' });
  assert.equal(nextEventText(ev, '2026-10-29'), 'Next: Games Friday, Oct 30 · First tip-off 5:30 PM');
});

test('practice next: after Saturday games, Monday practice beats next Friday', { skip }, async () => {
  const { nextEvent, nextEventText } = await mod();
  const gameDays = [{ date: '2026-10-24', first: '09:00' }, { date: '2026-10-30', first: '17:30' }];
  const ev = nextEvent({ today: '2026-10-24', now: '15:00', gameDays, practice });
  assert.deepEqual(ev, { type: 'practice', date: '2026-10-26', time: '17:00' });
  assert.equal(nextEventText(ev, '2026-10-24'), 'Next: Practice Monday, Oct 26 · 5:00 PM');
  // tonight's practice still counts until it ends; the cheer screen skips Wednesday (no cheer that night)
  assert.equal(nextEventText(nextEvent({ today: '2026-10-26', now: '20:30', gameDays, practice }), '2026-10-26'), 'Practice tonight · now', 'under way -> tonight · now');
  assert.equal(nextEventText(nextEvent({ today: '2026-10-26', now: '16:00', gameDays, practice }), '2026-10-26'), 'Next: Practice Today · 5:00 PM');
  assert.deepEqual(nextEvent({ today: '2026-10-27', now: '12:00', gameDays, practice, kind: 'cheer' }), { type: 'game', date: '2026-10-30', time: '17:30' });
  assert.deepEqual(nextEvent({ today: '2026-10-27', now: '12:00', gameDays, practice, kind: 'basketball' }), { type: 'practice', date: '2026-10-28', time: '16:30' });
  // a game day today whose first tip already passed is skipped
  assert.equal(nextEvent({ today: '2026-10-24', now: '08:00', gameDays, practice }).type, 'game');
});

test('neither: nothing scheduled', { skip }, async () => {
  const { nextEvent, nextEventText } = await mod();
  const ev = nextEvent({ today: '2026-10-24', now: '12:00', gameDays: [{ date: '2026-10-17', first: '09:00' }], practice: { days: [{ day: 1, start: '17:00', end: '21:00' }], basketball: [], cheer: [] } });
  assert.equal(ev, null);
  assert.equal(nextEventText(ev, '2026-10-24'), 'No games or practices scheduled');
});
