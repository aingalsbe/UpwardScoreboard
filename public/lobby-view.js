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
  // Split live: the floor is split, so its next split game(s) come first. Full live or nothing live: the soonest
  // next game(s) across all courts (L1: a 7:00 Full live with 8:00 split games shows the 8:00 split games next).
  if (now?.layout === 'split') next = splitNext || fullNext;
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
export const COURT_LABEL = { west: 'WEST COURT', east: 'EAST COURT', full: 'FULL COURT' };
/** Text for an empty court: a later game exists -> "No game right now"; nothing left on that court today -> "No more games on this court". */
export const emptyNote = (plan, court) => (plan.remaining?.[court] ? 'No game right now' : 'No more games on this court');

// ---- Demo mode (?at=YYYY-MM-DDTHH:MM or ?day=fri|sat&at=HH:MM) and the idle screen. Read-only, client-side. ----
const dowOfDate = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const DAY_DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The game day for ?day=fri|sat (or any weekday): the first date on/after today in `days` ([{date, first}], ascending)
 * with that weekday; if there is none, the next date that has games; else null (the caller falls back to the server).
 */
export function pickGameDay(day, days, today) {
  const ahead = (days || []).filter((d) => d.date >= today);
  const dow = DAY_DOW[String(day || '').toLowerCase().slice(0, 3)];
  return (dow != null && ahead.find((d) => dowOfDate(d.date) === dow)?.date) || ahead[0]?.date || null;
}

/** Parse the demo query: ?at=2026-10-24T11:00 or ?day=sat&at=11:00 (also ?date=..&at=..). Returns { date|null, day|null, at 'HH:MM' } or null. */
export function parseDemo(params) {
  const at = String(params.get('at') || '').trim();
  let m = at.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})$/);
  if (m) return { date: m[1], day: null, at: `${m[2].padStart(2, '0')}:${m[3]}` };
  m = at.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : null;
  return { date, day: date ? null : (params.get('day') || null), at: `${m[1].padStart(2, '0')}:${m[2]}` };
}

/**
 * Games as if it were `at` (HH:MM) on their day: a game whose window [time, time + dur) covers `at` is live (stored
 * score, or 0-0; a frozen, plausible period + clock), earlier ones are complete, later ones scheduled. Pure; the
 * server is never told.
 */
export function demoGames(games, at, quarterMs = 8 * 60000) {
  const t = toMin(at);
  return (games || []).map((g) => {
    if (!g.time) return g;
    const start = toMin(g.time), dur = g.dur || 60, periods = g.periods || 4;
    if (t < start) return { ...g, status: 'scheduled' };
    if (t >= start + dur) return { ...g, status: 'complete' };
    const frac = (t - start) / dur, period = Math.min(periods, Math.floor(frac * periods) + 1);
    const inPeriod = frac * periods - (period - 1);
    return { ...g, status: 'active', period, periods, clock: { running: false, startedAt: null, remainingMs: Math.max(1000, Math.round(quarterMs * (1 - inPeriod) / 1000) * 1000) },
      home: { ...g.home, score: g.home?.score ?? 0 }, away: { ...g.away, score: g.away?.score ?? 0 } };
  });
}
/** "DEMO · Sat 11:00 AM" */
export const demoTag = (date, at) => `DEMO · ${SHORT[dowOfDate(date)]} ${ampm(at)}`;

/** Idle line: the next game day after `date` (strictly later) -> "Next games: Friday, Oct 23 · First tip-off 5:30 PM". */
export function idleText(days, date) {
  const n = (days || []).find((d) => d.date > date);
  if (!n) return 'No games scheduled';
  const [, mo, dd] = n.date.split('-').map(Number);
  return `Next games: ${LONG[dowOfDate(n.date)]}, ${MON[mo - 1]} ${dd} · First tip-off ${ampm(n.first)}`;
}
