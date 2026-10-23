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
/** Period label, same scheme as every screen (common.js periodLabel): "1st Half · P2", "2nd Half · P5", OT, OT2. */
export const quarter = (p, periods = 6) => (!p ? '' : p > periods ? `OT${p - periods > 1 ? p - periods : ''}` : `${p <= Math.ceil(periods / 2) ? '1st' : '2nd'} Half · P${p}`);

/**
 * Lobby roll-off: true once an active game reaches halftime: period past the first half (P4+, or OT), or the
 * last first-half period (P3) with its clock run out (stopped at 0:00). The lobby then shows that court's next game.
 */
export function pastHalftime(g) {
  if (!g || g.status !== 'active' || !g.period) return false;
  const half = Math.ceil((g.periods || 6) / 2);
  if (g.period > half) return true;
  return g.period === half && !!g.clock && !g.clock.running && g.clock.remainingMs <= 0;
}

/**
 * games: the schedule snapshot's games for one day ({ id, court, time 'HH:MM', status, ... }).
 * cheerSlots: [{ start 'HH:00', name, coach, locker, logo }].
 * Returns { now, next, header, nextTime, cheer: { now, next }, empty }:
 *   now / next = { layout: 'full' | 'split', courts: { full } | { west, east } } (a court value may be null) or null.
 */
export function planLobby(games, cheerSlots = []) {
  const on = (c, st) => games.filter((g) => g.court === c && g.status === st && (st === 'active' || g.time)).sort(byTime);
  // Halftime roll-off (round 2): an active game at/after halftime leaves the lobby (see pastHalftime).
  // QA M (Avery, 70f363b): it only rolls off when there is something to move up; a court's last game of the day (for
  // Full: the day's last game on any court) stays on top through the 2nd half until it goes final.
  const act = (c) => on(c, 'active');
  const anySched = (c) => on(c, 'scheduled').length > 0;
  const canRoll = { full: anySched('full') || anySched('west') || anySched('east'), west: anySched('west'), east: anySched('east') };
  const keep = (c, g) => !pastHalftime(g) || !canRoll[c];
  const live = { full: act('full').find((g) => keep('full', g)) || null, west: act('west').find((g) => keep('west', g)) || null, east: act('east').find((g) => keep('east', g)) || null };
  const rolled = { full: !live.full && act('full').some(pastHalftime), west: !live.west && act('west').some(pastHalftime), east: !live.east && act('east').some(pastHalftime) };
  const used = new Set(Object.values(live).filter(Boolean).map((g) => g.id));
  const nxt = (c) => on(c, 'scheduled').filter((g) => !used.has(g.id))[0] || null;

  /** The soonest next band (L1: a 7:00 Full with 8:00 split games -> the 8:00 split games), after the games in `used`. */
  const nextBand = (preferSplit) => {
    const N = { full: nxt('full'), west: nxt('west'), east: nxt('east') };
    const splitNext = N.west || N.east ? { layout: 'split', courts: { west: N.west, east: N.east } } : null;
    const fullNext = N.full ? { layout: 'full', courts: { full: N.full } } : null;
    const firstSplit = [N.west, N.east].filter(Boolean).map((g) => g.time).sort()[0];
    if (preferSplit) return splitNext || fullNext;
    return fullNext && (!firstSplit || N.full.time < firstSplit) ? fullNext : splitNext || fullNext;
  };
  const take = (band) => { if (band) for (const g of Object.values(band.courts)) if (g) used.add(g.id); return band; };

  let now = null;
  if (live.full) now = { layout: 'full', courts: { full: live.full } };
  else if (live.west || live.east) {
    // Split floor still live on one court: a court whose game hit halftime shows its next game on top (upcoming).
    const promo = (c) => live[c] || (rolled[c] ? nxt(c) : null);
    now = take({ layout: 'split', courts: { west: promo('west'), east: promo('east') } });
  } else if (rolled.full || rolled.west || rolled.east) {
    // Nothing live anymore (all at halftime): the next band moves up to the top slot, shown as upcoming.
    now = take(nextBand(!rolled.full));
  }
  // Split on top: the floor is split, so its next split game(s) come first. Full on top or nothing: the soonest.
  let next = nextBand(now?.layout === 'split');

  const times = (band) => (band ? Object.values(band.courts).filter(Boolean).map((g) => g.time).filter(Boolean).sort() : []);
  // QA L(b): with one court promoted (top mixes a live 11:00 and a Tip-off 12:00), Up Next is ONE time slot: the soonest
  // remaining start; a court with nothing at that time shows "No game right now". The top cheer row follows the
  // earliest game on top (the slot still being played), Up Next's cheer row follows Up Next's time.
  const promoted = !!now && Object.values(now.courts).some((g) => g && g.status !== 'active');
  const mixedTop = promoted && Object.values(now.courts).some((g) => g && g.status === 'active');
  if (mixedTop && next) {
    const t0 = times(next)[0];
    next = { ...next, courts: Object.fromEntries(Object.entries(next.courts).map(([c, g]) => [c, g && g.time === t0 ? g : null])) };
  }
  const nowTime = mixedTop ? times(now)[0] : times(now).pop() || null; // otherwise the latest start on top = the current slot
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
 * Games as if it were `at` (HH:MM) on their day: a game whose window [time, time + dur) covers `at` is active (stored
 * score, or 0-0), earlier ones are complete, later ones scheduled. Pure; the server is never told.
 * Demo clock = real game time: 6:00 periods from tip-off, P1-P3 in the first 18 min, halftime from start + 18 min
 * (P3 at 0:00), the 2nd half from start + DEMO_HALFTIME_MIN (20 = 3 x 6 min + a 2-min buffer) on. So `?at` at or
 * after start + 18 min shows the halftime roll-off (that court's next game moves to the top of the lobby).
 */
export const DEMO_HALFTIME_MIN = 20;
export function demoGames(games, at, periodMs = 6 * 60000) {
  const t = toMin(at), pMin = periodMs / 60000;
  return (games || []).map((g) => {
    if (!g.time) return g;
    const start = toMin(g.time), dur = g.dur || 60, periods = g.periods || 6, half = Math.ceil(periods / 2);
    if (t < start) return { ...g, status: 'scheduled' };
    if (t >= start + dur) return { ...g, status: 'complete' };
    const e = t - start;
    let period, leftMin;
    if (e < half * pMin) { period = Math.floor(e / pMin) + 1; leftMin = pMin - (e - (period - 1) * pMin); }
    else if (e < DEMO_HALFTIME_MIN) { period = half; leftMin = 0; } // halftime
    else { const k = Math.floor((e - DEMO_HALFTIME_MIN) / pMin); period = Math.min(periods, half + 1 + k); leftMin = Math.max(0, pMin - (e - DEMO_HALFTIME_MIN - k * pMin)); }
    return { ...g, status: 'active', period, periods, clock: { running: false, startedAt: null, remainingMs: Math.round(leftMin * 60000) },
      home: { ...g.home, score: g.hideScore ? null : g.home?.score ?? 0 }, away: { ...g.away, score: g.hideScore ? null : g.away?.score ?? 0 } };
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

/** Round 2 roll-up: a game promoted to the top slot (earlier game at halftime) shows "Tip-Off: 12:00 PM" where the
 *  score goes until it has started. Started = status 'active' (scorekeeper/Admin starts the game); null otherwise. */
export function tipOffText(g, slot) {
  return slot === 'now' && g && g.status !== 'active' && g.time ? `Tip-Off: ${ampm(g.time)}` : null;
}
