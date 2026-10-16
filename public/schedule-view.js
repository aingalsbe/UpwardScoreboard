// Pure view helpers for the schedule screen (no DOM), shared with the unit tests.
/** "16:30" -> "4:30" (lobby style). */
export const t12 = (hm) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`; };
/** home | away | tie for a complete game, else ''. */
export const winnerOf = (status, hs, as) => (status !== 'complete' ? '' : (hs ?? 0) > (as ?? 0) ? 'home' : (as ?? 0) > (hs ?? 0) ? 'away' : 'tie');
/** Status tag text: icon + word, never color alone. */
export function statusTag(state, winner, isNext, time) {
  if (state === 'complete') return winner === 'tie' ? '✓ FINAL · TIE' : '✓ FINAL';
  if (state === 'active') return '● LIVE';
  return isNext ? '🕒 UP NEXT' : `🕒 ${t12(time)}`;
}
/** Text for a day without games. */
export const emptyText = (isToday, dayLabel) => (isToday ? 'No games scheduled today' : `No games scheduled for ${dayLabel}`);

// ---- Paging rule (2026-10, Aaron): live + UP NEXT pinned, later upcoming paged, finals fill the leftover space. ----
const SPLIT = ['west', 'east'];
const isSplit = (g) => SPLIT.includes(g.court);
const byTime = (a, b) => (a.time || '').localeCompare(b.time || '') || SPLIT.indexOf(a.court) - SPLIT.indexOf(b.court);

/** Root phase: early = nothing complete yet, end = nothing upcoming (and something played), else midday. '' for no games. */
export function phaseOf(games) {
  if (!games.length) return '';
  if (!games.some((g) => g.status === 'complete')) return 'early';
  if (!games.some((g) => g.status === 'scheduled')) return 'end';
  return 'midday';
}

/**
 * UP NEXT ids: the first scheduled game on each court. Full shares the floor with West/East, so a Full game is only
 * "next" when no West/East game is scheduled before it (and a West/East game only when no Full game comes first).
 */
export function nextIdsOf(games) {
  const sched = games.filter((g) => g.status === 'scheduled').sort(byTime);
  const firstSplit = sched.find(isSplit)?.time, firstFull = sched.find((g) => !isSplit(g))?.time;
  const ids = new Set();
  for (const c of new Set(sched.map((g) => g.court))) {
    const n = sched.find((g) => g.court === c);
    const other = isSplit(n) ? firstFull : firstSplit;
    if (other === undefined || n.time <= other) ids.add(n.id);
  }
  return ids;
}

/**
 * Order the day for the screen. pinned = live + UP NEXT (never paged) + upcoming same-time companions on the other
 * split court, later = the other upcoming games,
 * finals = complete games; each list time-sorted (West before East at one time).
 */
export function planSchedule(games) {
  const nextIds = nextIdsOf(games);
  const all = [...games].sort(byTime);
  const key = new Set(all.filter((g) => g.status === 'active' || nextIds.has(g.id)).map((g) => g.id));
  // Companion: an upcoming West/East game whose same-time game on the other court is pinned joins that pinned row, so
  // neither the pinned row nor the track gets an empty cell for it (e.g. West 9:00 next + East 9:00).
  const partnerPinned = (g) => isSplit(g) && all.some((o) => key.has(o.id) && isSplit(o) && o.court !== g.court && o.time === g.time);
  const pin = new Set([...key, ...all.filter((g) => g.status === 'scheduled' && !key.has(g.id) && partnerPinned(g)).map((g) => g.id)]);
  return {
    phase: phaseOf(games), nextIds,
    pinned: all.filter((g) => pin.has(g.id)),
    later: all.filter((g) => g.status === 'scheduled' && !pin.has(g.id)),
    finals: all.filter((g) => g.status === 'complete'),
  };
}

/**
 * Blocks in time order (used for .sched-pinned and .sched-track): runs of West/East games share one two-column block with one row per time (a missing court is
 * null, so both columns stay aligned); each Full Court game is its own full-width row.
 */
export function blocksOf(games) {
  const blocks = [];
  for (const g of [...games].sort(byTime)) {
    const last = blocks[blocks.length - 1];
    if (!isSplit(g)) { blocks.push({ type: 'full', game: g }); continue; }
    const b = last?.type === 'split' ? last : (blocks.push({ type: 'split', rows: [] }), blocks[blocks.length - 1]);
    let row = b.rows.find((r) => r.time === g.time);
    if (!row) b.rows.push(row = { time: g.time, west: null, east: null });
    row[g.court] = g;
  }
  return blocks;
}

/** Number of screen rows the games take (a West/East pair at one time is one row). */
export const rowCount = (games) => blocksOf(games).reduce((n, b) => n + (b.type === 'full' ? 1 : b.rows.length), 0);

/**
 * Finals collapse: keep the most recent finals that fit in `rows` leftover rows (whole rows, so a West/East pair stays
 * together); the rest are counted in "▲ N earlier finals". shown keeps time order.
 */
export function collapseFinals(finals, rows) {
  const units = [];
  for (const b of blocksOf(finals)) { if (b.type === 'full') units.push([b.game]); else for (const r of b.rows) units.push([r.west, r.east].filter(Boolean)); }
  const keep = Math.max(0, Math.min(units.length, Math.floor(rows)));
  const shown = units.slice(units.length - keep).flat();
  return { shown, earlier: finals.length - shown.length };
}

/** "▲ N earlier finals" (empty for 0). */
export const earlierText = (n) => (n ? `▲ ${n} earlier final${n === 1 ? '' : 's'}` : '');

/**
 * Page offsets for the track: pages break at row tops so a row is never cut. rowTops/rowBottoms in px from the track
 * top, viewH = visible height. One page (offset 0) when everything fits.
 */
export function pageOffsets(rowTops, rowBottoms, viewH) {
  const pages = [0];
  if (!rowBottoms.length || Math.max(...rowBottoms) <= viewH + 0.5) return pages;
  for (let i = 0; i < rowTops.length; i++) {
    const cur = pages[pages.length - 1];
    if (rowBottoms[i] > cur + viewH + 0.5 && rowTops[i] > cur) pages.push(rowTops[i]);
  }
  return pages;
}
