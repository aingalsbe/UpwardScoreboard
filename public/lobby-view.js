// Pure selection for the lobby TV (no DOM), shared with the unit tests (test/lobby-view.test.ts).
// Per court: the live game plus exactly ONE next game, or just the next game when nothing is live there.
// Full Court shares the floor with West/East, so a band is either "full" (one panel spanning both) or "split".
// Cheer is one squad per time slot (league date + hour), shared by every court; a slot without a squad has no row.

const SPLIT = ['west', 'east'];
const byTime = (a, b) => (a.time || '').localeCompare(b.time || '') || a.id - b.id;
/** "09:05" -> "09:00": the cheer slot a start time falls in. */
export const hourOf = (hm) => `${String(hm || '').slice(0, 2)}:00`;
/** "16:30" -> "4:30 PM". */
export const ampm = (hm) => { const [h, m] = String(hm).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
/** "2026-10-24", "11:00" -> "SATURDAY 11:00 AM" (the lobby header). */
export const headerText = (date, hm) => `${DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]}${hm ? ' ' + ampm(hm) : ''}`;
/** Period label like the mockup: Q1..Q4, OT, OT2. */
export const quarter = (p, periods) => (!p ? '' : p > periods ? `OT${p - periods > 1 ? p - periods : ''}` : `Q${p}`);

/**
 * games: the schedule snapshot's games for one day ({ id, court, time 'HH:MM', status, ... }).
 * cheerSlots: [{ start 'HH:00', name, coach, locker, logo }].
 * Returns { now, next, header, nextTime, cheer: { now, next }, empty }:
 *   now / next = { layout: 'full' | 'split', courts: { full } | { west, east } } (a court value may be null) or null.
 */
export function planLobby(games, cheerSlots = []) {
  const on = (c, st) => games.filter((g) => g.court === c && g.status === st && (st === 'active' || g.time)).sort(byTime);
  const live = { full: on('full', 'active')[0] || null, west: on('west', 'active')[0] || null, east: on('east', 'active')[0] || null };
  const liveIds = new Set(Object.values(live).filter(Boolean).map((g) => g.id));
  const nxt = (c) => on(c, 'scheduled').filter((g) => !liveIds.has(g.id))[0] || null;
  const N = { full: nxt('full'), west: nxt('west'), east: nxt('east') };

  let now = null;
  if (live.full) now = { layout: 'full', courts: { full: live.full } };
  else if (live.west || live.east) now = { layout: 'split', courts: { west: live.west, east: live.east } };

  const splitNext = N.west || N.east ? { layout: 'split', courts: { west: N.west, east: N.east } } : null;
  const fullNext = N.full ? { layout: 'full', courts: { full: N.full } } : null;
  const firstSplit = [N.west, N.east].filter(Boolean).map((g) => g.time).sort()[0];
  let next;
  if (now?.layout === 'full') next = fullNext || splitNext;
  else if (now?.layout === 'split') next = splitNext || fullNext;
  else next = fullNext && (!firstSplit || N.full.time < firstSplit) ? fullNext : splitNext || fullNext;

  const times = (band) => (band ? Object.values(band.courts).filter(Boolean).map((g) => g.time).filter(Boolean).sort() : []);
  const nowTime = times(now).pop() || null; // the latest live start = the current slot
  const nextTime = times(next)[0] || null;
  const slotAt = (hm) => (hm ? cheerSlots.find((s) => s.start === hourOf(hm)) || null : null);
  const cheerNow = slotAt(nowTime);
  let cheerNext = slotAt(nextTime);
  if (cheerNow && cheerNext && cheerNow.start === cheerNext.start) cheerNext = null; // same hour: one row
  // courts with anything still to play today (live or scheduled), for the empty-court text
  const remaining = Object.fromEntries(['full', ...SPLIT].map((c) => [c, games.some((g) => g.court === c && (g.status === 'active' || g.status === 'scheduled'))]));
  // mixed day: the next band's layout differs from the live band's, so its courts have no tabs and need a text label
  const mixed = !!(now && next && now.layout !== next.layout);
  return { now, next, header: nowTime || nextTime, nextTime, cheer: { now: cheerNow, next: cheerNext }, empty: !now && !next, remaining, mixed };
}

/** Court label text for next games on mixed days (a real element, not CSS attr()). */
export const COURT_LABEL = { west: 'WEST', east: 'EAST', full: 'FULL COURT' };
/** Text for an empty court: a later game exists -> "No game right now"; nothing left on that court today -> "No more games on this court". */
export const emptyNote = (plan, court) => (plan.remaining?.[court] ? 'No game right now' : 'No more games on this court');
