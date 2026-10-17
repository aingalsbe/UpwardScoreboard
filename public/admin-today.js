// Admin "Today" games list: pure helpers (no DOM), shared with the unit tests.
/**
 * Which games the Today list shows and in what order. Same set as before (every game that isn't complete) plus the
 * games completed today (league day), so a finished game keeps its row with the result. Order: time slot, then court
 * (the courts list order), then id; undated games last.
 * @param dateOf iso -> 'YYYY-MM-DD' in the league time zone
 */
export function todayGames(games, courts, today, dateOf) {
  const courtIdx = new Map(courts.map((c, i) => [c.id, i]));
  const t = (g) => (g.scheduled_at ? new Date(g.scheduled_at).getTime() : Infinity);
  return games
    .filter((g) => g.status !== 'complete' || (g.scheduled_at && dateOf(g.scheduled_at) === today))
    .sort((a, b) => t(a) - t(b) || (courtIdx.get(a.court_id) ?? 99) - (courtIdx.get(b.court_id) ?? 99) || a.id - b.id);
}

/** Inline result: complete -> final (or tie), active -> live, scheduled -> '' (unchanged). Home score first. */
export function resultOf(g) {
  const hs = g.home_score ?? 0, as = g.away_score ?? 0, score = `${hs}–${as}`;
  if (g.status === 'complete') return { kind: hs === as ? 'tie' : 'final', score, winner: hs > as ? 'home' : as > hs ? 'away' : 'tie' };
  if (g.status === 'active') return { kind: 'live', score, winner: '' };
  return { kind: '', score, winner: '' };
}
