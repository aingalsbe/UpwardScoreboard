// Lobby TV selection (public/lobby-view.js, a plain browser module). Skipped where public/ is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const skip = !fs.existsSync(path.join(PUB, 'lobby-view.js')) && 'public/ not present (image build)';
const load = () => import(path.join(PUB, 'lobby-view.js'));
let n = 0;
const G = (court: string, time: string, status = 'scheduled') => ({ id: ++n, court, time, status, home: { name: `H${n}` }, away: { name: `A${n}` } });
const ids = (band: any) => band && Object.fromEntries(Object.entries(band.courts).map(([k, g]: any) => [k, g?.id ?? null]));

test('split: live + exactly one next per court; cheer for the live and next hours', { skip }, async () => {
  const { planLobby } = await load();
  const w10 = G('west', '10:00', 'complete'), w11 = G('west', '11:00', 'active'), e11 = G('east', '11:05', 'active');
  const w12 = G('west', '12:00'), e12 = G('east', '12:00'), w13 = G('west', '13:00'), f16 = G('full', '16:30');
  const p = planLobby([w13, w10, w11, e11, w12, e12, f16], [{ start: '11:00', name: 'Pep' }, { start: '12:00', name: 'Spirit' }]);
  assert.deepEqual(ids(p.now), { west: w11.id, east: e11.id }); assert.equal(p.now.layout, 'split');
  assert.deepEqual(ids(p.next), { west: w12.id, east: e12.id });
  assert.equal(p.header, '11:05'); assert.equal(p.nextTime, '12:00');
  assert.deepEqual([p.cheer.now?.name, p.cheer.next?.name], ['Pep', 'Spirit']);
});

test('no live game: just the next game per court (and the next slot\'s cheer)', { skip }, async () => {
  const { planLobby } = await load();
  const w8 = G('west', '08:00'), e8 = G('east', '08:00'), w9 = G('west', '09:00');
  const p = planLobby([w9, w8, e8], [{ start: '08:00', name: 'Early' }]);
  assert.equal(p.now, null); assert.deepEqual(ids(p.next), { west: w8.id, east: e8.id });
  assert.equal(p.header, '08:00'); assert.equal(p.cheer.now, null); assert.equal(p.cheer.next?.name, 'Early');
  // one court live, the other only upcoming: the idle court still shows its next game
  const q = planLobby([{ ...w8, status: 'active' }, e8, w9], []);
  assert.deepEqual(ids(q.now), { west: w8.id, east: null }); assert.deepEqual(ids(q.next), { west: w9.id, east: e8.id });
});

test('Full Court: live + next in one spanning panel; split games never mix into a full band', { skip }, async () => {
  const { planLobby } = await load();
  const f5 = G('full', '17:30', 'active'), f6 = G('full', '18:30'), f7 = G('full', '19:30');
  const p = planLobby([f7, f6, f5], []);
  assert.equal(p.now.layout, 'full'); assert.deepEqual(ids(p.now), { full: f5.id }); assert.deepEqual(ids(p.next), { full: f6.id });
  // nothing live: Full is next only when it starts before any West/East game
  const w8 = G('west', '08:00'), fA = G('full', '16:30');
  assert.equal(planLobby([w8, fA], []).next.layout, 'split');
  assert.equal(planLobby([fA], []).next.layout, 'full');
  // split live, no more split games: the next band is Full Court
  const w15 = G('west', '15:00', 'active');
  const q = planLobby([w15, fA], []);
  assert.equal(q.now.layout, 'split'); assert.equal(q.next.layout, 'full'); assert.deepEqual(ids(q.next), { full: fA.id });
});

test('a slot with no squad has no cheer row; the same hour is shown once', { skip }, async () => {
  const { planLobby } = await load();
  const w9 = G('west', '09:00', 'active'), w930 = G('west', '09:30'), w10 = G('west', '10:00');
  const none = planLobby([w9, w10], [{ start: '11:00', name: 'Later' }]);
  assert.equal(none.cheer.now, null); assert.equal(none.cheer.next, null);
  const same = planLobby([w9, w930], [{ start: '09:00', name: 'Nine' }]);
  assert.equal(same.cheer.now?.name, 'Nine'); assert.equal(same.cheer.next, null);
});

test('nothing left today = empty; header and time formatting', { skip }, async () => {
  const { planLobby, headerText, ampm, quarter, hourOf } = await load();
  const p = planLobby([G('west', '08:00', 'complete')], []);
  assert.equal(p.empty, true); assert.equal(p.now, null); assert.equal(p.next, null);
  assert.equal(headerText('2026-10-24', '11:00'), 'SATURDAY 11:00 AM'); assert.equal(headerText('2026-10-23', '17:15'), 'FRIDAY 5:15 PM');
  assert.equal(ampm('00:30'), '12:30 AM'); assert.equal(ampm('12:00'), '12:00 PM');
  assert.equal(quarter(2, 4), 'Q2'); assert.equal(quarter(5, 4), 'OT'); assert.equal(quarter(6, 4), 'OT2'); assert.equal(hourOf('09:59'), '09:00');
});

test('mixed days and empty-court text', { skip }, async () => {
  const { planLobby, emptyNote, COURT_LABEL } = await load();
  // West live, East already done, next game on Full: mixed; East has nothing left; Full has a later game
  const w15 = G('west', '15:00', 'active'), e14 = G('east', '14:00', 'complete'), f16 = G('full', '16:30');
  const p = planLobby([w15, e14, f16], []);
  assert.equal(p.mixed, true);
  assert.equal(emptyNote(p, 'east'), 'No more games on this court');
  assert.equal(emptyNote(p, 'full'), 'No game right now');
  // East has a later game but nothing live: "No game right now"
  const e16 = G('east', '16:00'), w9 = G('west', '09:00', 'active');
  const q = planLobby([w9, e16], []);
  assert.equal(q.mixed, false); assert.equal(emptyNote(q, 'east'), 'No game right now');
  assert.deepEqual(COURT_LABEL, { west: 'WEST COURT', east: 'EAST COURT', full: 'FULL COURT' });
  // Full live then split next: mixed too
  assert.equal(planLobby([G('full', '08:00', 'active'), G('west', '10:00')], []).mixed, true);
});

test('L1: Full live at 7:00 AM, split games at 8:00, next Full at 5:30 PM -> UP NEXT is the 8:00 split games (mixed)', { skip }, async () => {
  const { planLobby } = await load();
  const f7 = G('full', '07:00', 'active'), w8 = G('west', '08:00'), e8 = G('east', '08:00'), w9 = G('west', '09:00'), f1730 = G('full', '17:30');
  const p = planLobby([f1730, w9, e8, w8, f7]);
  assert.deepEqual(ids(p.now), { full: f7.id }); assert.equal(p.now.layout, 'full');
  assert.equal(p.next.layout, 'split'); assert.deepEqual(ids(p.next), { west: w8.id, east: e8.id });
  assert.equal(p.nextTime, '08:00'); assert.equal(p.mixed, true);
  // and when the next Full game is sooner than any split game, it stays the Full game
  const q = planLobby([G('full', '07:00', 'active'), G('full', '08:00'), G('west', '09:00')]);
  assert.equal(q.next.layout, 'full'); assert.equal(q.mixed, false);
});
