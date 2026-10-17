// Admin Today list (public/admin-today.js): which games show, order, inline result. Skipped without public/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const skip = !fs.existsSync(path.join(PUB, 'admin-today.js')) && 'public/ not present (image build)';
const load = () => import(path.join(PUB, 'admin-today.js'));
const dateOf = (iso: string) => iso.slice(0, 10);
const courts = [{ id: 1, slug: 'full' }, { id: 2, slug: 'west' }, { id: 3, slug: 'east' }];
const G = (id: number, at: string | null, court_id: number, status: string, hs = 0, as = 0) => ({ id, scheduled_at: at, court_id, status, home_score: hs, away_score: as });

test('A1: completed games of today stay in the Today list (older finals drop), order = time, then court', { skip }, async () => {
  const v = await load();
  const games = [
    G(1, '2026-10-17T10:00:00Z', 3, 'scheduled'), G(2, '2026-10-17T09:00:00Z', 3, 'complete', 12, 16),
    G(3, '2026-10-17T09:00:00Z', 2, 'complete', 20, 20), G(4, '2026-10-17T10:00:00Z', 2, 'active', 7, 3),
    G(5, '2026-10-16T18:00:00Z', 1, 'complete', 31, 27), G(6, null, 2, 'scheduled'), G(7, '2026-10-18T09:00:00Z', 2, 'scheduled'),
  ];
  assert.deepEqual(v.todayGames(games, courts, '2026-10-17', dateOf).map((g: any) => g.id), [3, 2, 4, 1, 7, 6]);
});

test('A1: inline result — FINAL (home first), TIE, LIVE, scheduled unchanged', { skip }, async () => {
  const v = await load();
  assert.deepEqual(v.resultOf(G(1, null, 1, 'complete', 24, 18)), { kind: 'final', score: '24–18', winner: 'home' });
  assert.deepEqual(v.resultOf(G(1, null, 1, 'complete', 12, 16)), { kind: 'final', score: '12–16', winner: 'away' });
  assert.deepEqual(v.resultOf(G(1, null, 1, 'complete', 20, 20)), { kind: 'tie', score: '20–20', winner: 'tie' });
  assert.deepEqual(v.resultOf(G(1, null, 1, 'active', 7, 3)), { kind: 'live', score: '7–3', winner: '' });
  assert.equal(v.resultOf(G(1, null, 1, 'scheduled')).kind, '');
});
