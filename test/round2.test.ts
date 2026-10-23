// Round 2 (2026-10): grade normalization for score hiding, K-2nd scorekeeper limits, lobby halftime roll-off + demo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScoreHiddenGrade } from '../src/schedule.js';
import { initialState, newHistory, dispatch, hiddenGameRefusal, isTeamStatCommand } from '../src/game.js';

test('isScoreHiddenGrade: K, Pre-K, 1st, 2nd in any spelling; 3rd+ never', () => {
  const yes = ['K', 'k', 'Kindergarten', 'KINDERGARTEN', 'Pre-K', 'PreK', 'pre k', 'PK', 'Pre-Kindergarten', 'kg', '1', '01', '1st', ' 1ST ', 'First',
    'first grade', '1st Grade', 'Grade 1', 'grade-1', 'Gr 1', 'Gr. 1', '2', '2nd', '2ND', 'Second', '2nd Grade', 'Gr 2', 'GR-2', 'grade_2', 'Grade: Second', '2nd  grade', '2nd-grade',
    '1st/2nd', 'K-2', '2nd Grade Boys', 'first grade girls', '２ｎｄ Ｇｒａｄｅ', 'Ｋ', 'Kíndergarten', 'Fírst', 'Pré-K'];
  const no = ['3', '3rd', '3rd Grade', 'Third', 'Grade 4', '5th Grade', '10', '12th', '11', '21', '22', '1st Grade Boys?x', '', null, undefined, 'Varsity', 'Grade', 'Kinder 3', 'Gr 12', '2nd/3rd', 'K-3', '3rd Grade Girls', '３rd'];
  for (const v of yes) assert.equal(isScoreHiddenGrade(v), true, `"${v}" should hide`);
  for (const v of no) assert.equal(isScoreHiddenGrade(v), false, `"${v}" should show`);
});

test('K-2nd server rule: score/foul/timeout refused; clock, period, possession, undo of those allowed', () => {
  let h = newHistory(initialState());
  for (const type of ['SCORE', 'FOUL', 'TIMEOUT']) assert.ok(hiddenGameRefusal('cmd', { type }, h), type);
  for (const type of ['CLOCK_START', 'CLOCK_STOP', 'CLOCK_SET', 'PERIOD', 'POSSESSION', 'BANNER', 'END_GAME']) assert.equal(hiddenGameRefusal('cmd', { type }, h), null, type);
  assert.equal(isTeamStatCommand({ type: 'PERIOD' }), false);
  h = dispatch(h, { type: 'PERIOD', delta: 1 }, 0);
  assert.equal(hiddenGameRefusal('undo', null, h), null, 'undo a period change is fine');
  // a legacy score already in the history may not be undone/redone on a hidden game
  h = dispatch(h, { type: 'SCORE', team: 'home', pts: 2 }, 0);
  assert.ok(hiddenGameRefusal('undo', null, h));
  assert.equal(hiddenGameRefusal('redo', null, h), null, 'nothing to redo');
});

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const skip = !fs.existsSync(path.join(PUB, 'lobby-view.js')) && 'public/ not present (image build)';
const load = () => import(path.join(PUB, 'lobby-view.js'));
const G = (id: number, court: string, time: string, status = 'scheduled', extra: any = {}) => ({ id, court, time, status, home: { name: `H${id}` }, away: { name: `A${id}` }, ...extra });
const at = (period: number, remainingMs = 60_000, running = false) => ({ period, periods: 6, clock: { running, remainingMs, startedAt: null } });
const ids = (band: any) => band && Object.fromEntries(Object.entries(band.courts).map(([k, g]: any) => [k, g?.id ?? null]));

test('pastHalftime: P4+ or P3 at 0:00 stopped', { skip }, async () => {
  const { pastHalftime } = await load();
  assert.equal(pastHalftime(G(1, 'west', '11:00', 'active', at(3, 30_000))), false);
  assert.equal(pastHalftime(G(1, 'west', '11:00', 'active', at(3, 0))), true, 'end of P3 = halftime');
  assert.equal(pastHalftime(G(1, 'west', '11:00', 'active', at(4))), true);
  assert.equal(pastHalftime(G(1, 'west', '11:00', 'active', at(7))), true, 'OT');
  assert.equal(pastHalftime(G(1, 'west', '11:00', 'scheduled', at(4))), false);
});

test('Saturday split: at halftime 11:00 rolls off, top shows 12:00 (upcoming), Up Next 1:00; cheer follows the top slot', { skip }, async () => {
  const { planLobby } = await load();
  const games = [G(1, 'west', '11:00', 'active', at(4)), G(2, 'east', '11:00', 'active', at(3, 0)),
    G(3, 'west', '12:00'), G(4, 'east', '12:00'), G(5, 'west', '13:00'), G(6, 'east', '13:00')];
  const cheer = [{ start: '11:00', name: 'Eleven' }, { start: '12:00', name: 'Noon' }, { start: '13:00', name: 'One' }];
  const p = planLobby(games, cheer);
  assert.deepEqual(ids(p.now), { west: 3, east: 4 }); assert.deepEqual(ids(p.next), { west: 5, east: 6 });
  assert.equal(p.header, '12:00'); assert.equal(p.nextTime, '13:00');
  assert.equal(p.cheer.now.name, 'Noon'); assert.equal(p.cheer.next.name, 'One');
  // before halftime: unchanged behavior
  const pre = planLobby([{ ...games[0], ...at(2) }, { ...games[1], ...at(3, 5000, true) }, ...games.slice(2)], cheer);
  assert.deepEqual(ids(pre.now), { west: 1, east: 2 }); assert.deepEqual(ids(pre.next), { west: 3, east: 4 }); assert.equal(pre.cheer.now.name, 'Eleven');
});

test('split, one court at halftime: that court promotes its next game; the other stays live', { skip }, async () => {
  const { planLobby } = await load();
  const p = planLobby([G(1, 'west', '11:00', 'active', at(5)), G(2, 'east', '11:00', 'active', at(2)), G(3, 'west', '12:00'), G(4, 'east', '12:00'), G(5, 'west', '13:00')]);
  assert.deepEqual(ids(p.now), { west: 3, east: 2 }); assert.deepEqual(ids(p.next), { west: null, east: 4 }, 'QA L(b): Up Next = the soonest slot only');
});

test('Friday Full Court: halftime rolls the 5:30 off, top shows 6:30, Up Next 7:30; last game at halftime stays until final', { skip }, async () => {
  const { planLobby } = await load();
  const p = planLobby([G(1, 'full', '17:30', 'active', at(4)), G(2, 'full', '18:30'), G(3, 'full', '19:30')]);
  assert.deepEqual(ids(p.now), { full: 2 }); assert.deepEqual(ids(p.next), { full: 3 }); assert.equal(p.now.layout, 'full');
  const last = planLobby([G(1, 'full', '19:30', 'active', at(6))]);
  assert.deepEqual(ids(last.now), { full: 1 }, 'QA M: nothing to move up -> stays until final'); assert.equal(last.next, null); assert.equal(last.empty, false);
  // Full at halftime with split games next (L1 mix): the soonest band moves up
  const mix = planLobby([G(1, 'full', '07:00', 'active', at(4)), G(2, 'west', '08:00'), G(3, 'east', '08:00'), G(4, 'full', '17:30')]);
  assert.deepEqual(ids(mix.now), { west: 2, east: 3 }); assert.deepEqual(ids(mix.next), { full: 4 });
});

test('demo ?at: 6:00 periods from tip-off, halftime from +18 min, 2nd half from +20 min -> roll-off', { skip }, async () => {
  const { demoGames, planLobby, pastHalftime, DEMO_HALFTIME_MIN } = await load();
  assert.equal(DEMO_HALFTIME_MIN, 20);
  const gs = [G(1, 'west', '11:00'), G(2, 'west', '12:00'), G(3, 'west', '13:00')];
  const g = (t: string) => demoGames(gs, t)[0];
  assert.deepEqual([g('11:00').period, g('11:00').clock.remainingMs], [1, 360_000]);
  assert.deepEqual([g('11:13').period, g('11:13').clock.remainingMs], [3, 300_000]);
  assert.deepEqual([g('11:18').period, g('11:18').clock.remainingMs], [3, 0]); assert.equal(pastHalftime(g('11:18')), true);
  assert.equal(g('11:21').period, 4); assert.equal(g('11:59').period, 6);
  assert.deepEqual(ids(planLobby(demoGames(gs, '11:10')).now), { west: 1, east: null });
  const half = planLobby(demoGames(gs, '11:25'));
  assert.deepEqual(ids(half.now), { west: 2, east: null }); assert.deepEqual(ids(half.next), { west: 3, east: null });
});

test('roll-up: promoted top game shows "Tip-Off: 12:00 PM" until it starts (status active), then live', { skip }, async () => {
  const { planLobby, tipOffText } = await load();
  const games = [G(1, 'west', '11:00', 'active', at(4)), G(3, 'west', '12:00'), G(5, 'west', '13:00')];
  const p = planLobby(games);
  assert.equal(tipOffText(p.now.courts.west, 'now'), 'Tip-Off: 12:00 PM');
  assert.equal(tipOffText(p.next.courts.west, 'next'), null, 'Up Next keeps its normal look');
  const started = planLobby([games[0], { ...games[1], status: 'active', ...at(1, 360_000) }, games[2]]);
  assert.equal(started.now.courts.west.id, 3); assert.equal(tipOffText(started.now.courts.west, 'now'), null, 'started -> live display');
  assert.equal(tipOffText(G(9, 'full', '17:30'), 'now'), 'Tip-Off: 5:30 PM');
});

test('QA L(c): gradeOrder knows words and abbreviations', async () => {
  const { gradeOrder } = await import('../src/schedule.js');
  assert.deepEqual(['First', 'Second', 'Gr 2', '2nd Grade', 'Kindergarten', 'Pre-K', 'Third Grade', 'Varsity', null].map(gradeOrder), [1, 2, 2, 2, 0, -1, 3, 99, 100]);
});
