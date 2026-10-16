// Schedule paging rule (public/schedule-view.js, a plain browser module): ordering, pinned selection, finals
// collapse, phase and page breaks. Skipped where public/ is absent (the Docker build stage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const skip = !fs.existsSync(path.join(PUB, 'schedule-view.js')) && 'public/ not present (image build)';
const load = () => import(path.join(PUB, 'schedule-view.js'));
let n = 0;
const G = (time: string, court: string, status = 'scheduled') => ({ id: ++n, time, court, status });
// A demo-like Saturday: West/East 8:00-15:00, Full 16:30-18:30.
function day(statusOf: (time: string, court: string) => string) {
  const gs = [];
  for (const h of ['08', '09', '10', '11', '12', '13', '14', '15']) for (const c of ['west', 'east']) gs.push(G(`${h}:00`, c, statusOf(`${h}:00`, c)));
  for (const t of ['16:30', '17:30', '18:30']) gs.push(G(t, 'full', statusOf(t, 'full')));
  return gs;
}
const ids = (gs: any[]) => gs.map((g) => `${g.time} ${g.court}`);

test('phase: early / midday / end / empty', { skip }, async () => {
  const v = await load();
  assert.equal(v.phaseOf(day(() => 'scheduled')), 'early');
  assert.equal(v.phaseOf(day((t, c) => (t === '08:00' && c === 'east' ? 'active' : 'scheduled'))), 'early'); // live but nothing final yet
  assert.equal(v.phaseOf(day((t) => (t < '10:00' ? 'complete' : 'scheduled'))), 'midday');
  assert.equal(v.phaseOf(day(() => 'complete')), 'end');
  assert.equal(v.phaseOf(day((t) => (t === '18:30' ? 'active' : 'complete'))), 'end'); // nothing upcoming
  assert.equal(v.phaseOf([]), '');
});

test('pinned: live + UP NEXT per court; Full is next only when no West/East game comes first', { skip }, async () => {
  const v = await load();
  const mid = v.planSchedule(day((t, c) => (t < '10:00' || (t === '10:00' && c === 'west') ? 'complete' : t === '10:00' ? 'active' : 'scheduled')));
  assert.deepEqual(ids(mid.pinned), ['10:00 east', '11:00 west', '11:00 east']); // live East + each court's next; Full 16:30 is not next
  const late = v.planSchedule(day((t) => (t < '15:00' ? 'complete' : t === '15:00' ? 'active' : 'scheduled')));
  assert.deepEqual(ids(late.pinned), ['15:00 west', '15:00 east', '16:30 full']); // both live + Full next
  const early = v.planSchedule(day(() => 'scheduled'));
  assert.deepEqual(ids(early.pinned), ['08:00 west', '08:00 east']);
  assert.equal(v.planSchedule(day(() => 'complete')).pinned.length, 0);
});

test('ordering: pinned, then later upcoming, then finals; each time-sorted, West before East', { skip }, async () => {
  const v = await load();
  const p = v.planSchedule(day((t, c) => (t < '10:00' || (t === '10:00' && c === 'west') ? 'complete' : t === '10:00' ? 'active' : 'scheduled')));
  assert.deepEqual(ids(p.later).slice(0, 3), ['12:00 west', '12:00 east', '13:00 west']);
  assert.deepEqual(ids(p.later).slice(-3), ['16:30 full', '17:30 full', '18:30 full']);
  assert.ok(p.later.every((g: any) => g.status === 'scheduled' && !p.nextIds.has(g.id)));
  assert.deepEqual(ids(p.finals), ['08:00 west', '08:00 east', '09:00 west', '09:00 east', '10:00 west']);
  assert.equal(p.pinned.length + p.later.length + p.finals.length, 19);
});

test('blocks: West/East rows stay aligned (null for a missing court), Full rows on their own', { skip }, async () => {
  const v = await load();
  const b = v.blocksOf([G('16:30', 'full'), G('11:00', 'east'), G('10:00', 'west'), G('10:00', 'east')]);
  assert.deepEqual(b.map((x: any) => x.type), ['split', 'full']);
  assert.deepEqual(b[0].rows.map((r: any) => [r.time, !!r.west, !!r.east]), [['10:00', true, true], ['11:00', false, true]]);
  assert.equal(v.rowCount([G('10:00', 'west'), G('10:00', 'east'), G('16:30', 'full')]), 2);
});

test('finals collapse: keep the most recent whole rows, count the rest', { skip }, async () => {
  const v = await load();
  const finals = v.planSchedule(day(() => 'complete')).finals; // 16 split games (8 rows) + 3 Full rows = 11 rows
  const five = v.collapseFinals(finals, 5);
  assert.deepEqual(ids(five.shown), ['14:00 west', '14:00 east', '15:00 west', '15:00 east', '16:30 full', '17:30 full', '18:30 full']);
  assert.equal(five.earlier, 12);
  assert.equal(v.earlierText(five.earlier), '▲ 12 earlier finals');
  assert.equal(v.earlierText(1), '▲ 1 earlier final');
  assert.equal(v.earlierText(0), '');
  assert.deepEqual(v.collapseFinals(finals, 0), { shown: [], earlier: 19 }); // upcoming overflow: all finals collapse
  assert.equal(v.collapseFinals(finals, 99).earlier, 0);
  assert.equal(v.collapseFinals(finals, 2.9).shown.length, 2); // whole rows only
});

test('page offsets: one page when it fits, breaks at row tops otherwise', { skip }, async () => {
  const v = await load();
  assert.deepEqual(v.pageOffsets([0, 100, 200], [90, 190, 290], 300), [0]);
  assert.deepEqual(v.pageOffsets([], [], 300), [0]);
  const tops = [0, 100, 200, 300, 400, 500, 600], bots = tops.map((t) => t + 90);
  assert.deepEqual(v.pageOffsets(tops, bots, 300), [0, 300, 600]); // a row is never cut
});

test('pinned rows align by time across West/East (empty cell where a court has no pinned game), Full stays full-width', { skip }, async () => {
  const v = await load();
  const mid = v.planSchedule(day((t, c) => (t < '10:00' || (t === '10:00' && c === 'west') ? 'complete' : t === '10:00' ? 'active' : 'scheduled')));
  const b = v.blocksOf(mid.pinned);
  assert.deepEqual(b.map((r: any) => r.type), ['split']);
  assert.deepEqual(b[0].rows.map((r: any) => [r.time, r.west && 'game', r.east && 'game']), [['10:00', null, 'game'], ['11:00', 'game', 'game']]);
  const late = v.blocksOf(v.planSchedule(day((t) => (t < '15:00' ? 'complete' : t === '15:00' ? 'active' : 'scheduled'))).pinned);
  assert.deepEqual(late.map((r: any) => r.type), ['split', 'full']);
  assert.equal(late[0].rows.length, 1);
});

test('companion: an upcoming game next to a pinned one at the same time joins the pinned row (no empty cells)', { skip }, async () => {
  const v = await load();
  // Avery's morning: West 8:00 live, East 8:00 next -> West next is 9:00; East 9:00 rides along in the pinned 9:00 row.
  const p = v.planSchedule(day((t, c) => (t === '08:00' && c === 'west' ? 'active' : 'scheduled')));
  assert.deepEqual(ids(p.pinned), ['08:00 west', '08:00 east', '09:00 west', '09:00 east']);
  assert.equal(p.later[0].time, '10:00');
  assert.ok(v.blocksOf(p.pinned)[0].rows.every((r: any) => r.west && r.east));
  assert.ok(!p.nextIds.has(p.pinned[3].id)); // the companion isn't UP NEXT (it keeps its time tag)
  // A final next to a pinned game does not move up (finals stay lowest priority): pinned keeps an empty cell.
  const mid = v.planSchedule(day((t, c) => (t < '10:00' || (t === '10:00' && c === 'west') ? 'complete' : t === '10:00' ? 'active' : 'scheduled')));
  assert.deepEqual(ids(mid.pinned), ['10:00 east', '11:00 west', '11:00 east']);
});
