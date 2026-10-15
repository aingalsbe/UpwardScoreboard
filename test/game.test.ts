import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, apply, dispatch, undo, redo, newHistory, remainingMs, isBonus, parseCommand } from '../src/game.js';

const T0 = 1_000_000;

test('score +1/+2/+3 and corrections never go below zero', () => {
  let s = initialState();
  s = apply(s, { type: 'SCORE', team: 'home', pts: 3 }, T0);
  s = apply(s, { type: 'SCORE', team: 'home', pts: 2 }, T0);
  s = apply(s, { type: 'SCORE', team: 'away', pts: 1 }, T0);
  s = apply(s, { type: 'SCORE', team: 'home', pts: -1 }, T0);
  assert.equal(s.home.score, 4);
  assert.equal(s.away.score, 1);
  assert.equal(s.seq, 4);
  const z = apply(initialState(), { type: 'SCORE', team: 'away', pts: -2 }, T0);
  assert.equal(z.away.score, 0);
  assert.equal(z.seq, 0, 'no-op does not bump seq');
});

test('fouls drive the bonus and reset at halftime', () => {
  let s = initialState({ bonusFouls: 3, periods: 4, foulReset: 'half' });
  for (let i = 0; i < 3; i++) s = apply(s, { type: 'FOUL', team: 'away', delta: 1 }, T0);
  assert.equal(s.away.fouls, 3);
  assert.equal(isBonus(s, 'home'), true);
  assert.equal(isBonus(s, 'away'), false);
  s = apply(s, { type: 'PERIOD', delta: 1 }, T0); // 1 -> 2, same half
  assert.equal(s.away.fouls, 3);
  s = apply(s, { type: 'PERIOD', delta: 1 }, T0); // 2 -> 3, second half
  assert.equal(s.away.fouls, 0);
});

test('clock is derived from server timestamps (no ticking drift)', () => {
  let s = initialState({ periodLengthMs: 60_000 });
  s = apply(s, { type: 'CLOCK_START' }, T0);
  assert.equal(s.status, 'live');
  assert.equal(remainingMs(s.clock, T0 + 15_000), 45_000);
  s = apply(s, { type: 'CLOCK_STOP' }, T0 + 20_000);
  assert.equal(s.clock.running, false);
  assert.equal(remainingMs(s.clock, T0 + 99_000), 40_000, 'stopped clock stays put');
  s = apply(s, { type: 'CLOCK_ADJUST', ms: 1000 }, T0 + 21_000);
  assert.equal(s.clock.remainingMs, 41_000);
  s = apply(s, { type: 'CLOCK_START' }, T0 + 30_000);
  assert.equal(remainingMs(s.clock, T0 + 200_000), 0, 'never negative');
  s = apply(s, { type: 'CLOCK_EXPIRE' }, T0 + 200_000);
  assert.equal(s.clock.running, false);
  assert.equal(s.clock.remainingMs, 0);
  s = apply(s, { type: 'CLOCK_SET', ms: 30_000 }, T0 + 201_000);
  assert.equal(s.clock.remainingMs, 30_000);
});

test('timeout uses one and stops the clock', () => {
  let s = initialState({ timeoutsPerGame: 2 });
  s = apply(s, { type: 'CLOCK_START' }, T0);
  s = apply(s, { type: 'TIMEOUT', team: 'home', delta: -1 }, T0 + 5000);
  assert.equal(s.home.timeoutsLeft, 1);
  assert.equal(s.clock.running, false);
  assert.equal(s.clock.remainingMs, s.rules.periodLengthMs - 5000);
});

test('undo/redo restores scores but keeps the live clock running', () => {
  let h = newHistory(initialState({ periodLengthMs: 60_000 }));
  h = dispatch(h, { type: 'CLOCK_START' }, T0);
  h = dispatch(h, { type: 'SCORE', team: 'home', pts: 2 }, T0 + 1000);
  h = dispatch(h, { type: 'FOUL', team: 'away', delta: 1 }, T0 + 2000);
  h = undo(h, T0 + 3000);
  assert.equal(h.present.away.fouls, 0);
  assert.equal(h.present.home.score, 2);
  assert.equal(h.present.clock.running, true, 'undo of a foul does not stop the clock');
  h = undo(h, T0 + 3000);
  assert.equal(h.present.home.score, 0);
  const seqAfterUndo = h.present.seq;
  h = redo(h, T0 + 4000);
  assert.equal(h.present.home.score, 2);
  assert.ok(h.present.seq > seqAfterUndo, 'seq stays monotonic');
  h = dispatch(h, { type: 'SCORE', team: 'away', pts: 3 }, T0 + 5000);
  assert.equal(h.future.length, 0, 'new action clears redo');
});

test('possession toggles and commands are validated', () => {
  let s = initialState();
  s = apply(s, { type: 'POSSESSION', team: 'toggle' }, T0);
  assert.equal(s.possession, 'home');
  s = apply(s, { type: 'POSSESSION', team: 'toggle' }, T0);
  assert.equal(s.possession, 'away');
  assert.throws(() => parseCommand({ type: 'SCORE', team: 'home', pts: 50 }));
  assert.throws(() => parseCommand({ type: 'SCORE', team: 'refs', pts: 2 }));
  assert.throws(() => parseCommand({ type: 'DROP_TABLE' }));
  assert.deepEqual(parseCommand({ type: 'SCORE', team: 'away', pts: '3' }), { type: 'SCORE', team: 'away', pts: 3 });
});
