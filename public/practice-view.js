// Practice TV planning (pure, testable). Data: GET /api/public/practice. Rules from Sage's data-needs.md:
// window = 60 min before the day's first slot .. 15 min after its end; basketball pages = 1-hour slots, the current
// slot (from 10 min before its start) shows 12 s then the next slot 8 s; before the first slot all slots page at 12 s;
// cheer has no times (one static page, 9 cards per page, paging at 12 s above 9 squads).
export const PRE_MIN = 60, POST_MIN = 15, EARLY_MIN = 10, PAGE_S = 12, NEXT_S = 8, CHEER_PER_PAGE = 9;
export const COURTS = ['west1', 'east1', 'west2', 'east2']; // mockup order: West left, East right
export const COURT_NAME = { west1: 'West 1', west2: 'West 2', east1: 'East 1', east2: 'East 2' };
export const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const LONG = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const TITLE = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const hm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
export const ampm = (t) => { const [h, m] = String(t).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
export const slotStarts = (start, end) => { const out = []; for (let t = toMin(start); t + 60 <= toMin(end); t += 60) out.push(hm(t)); return out; };

/** ?day=mon..thu&at=HH:MM (both optional; at alone keeps today) -> { dow, hm } or null. */
export function parsePracticeDemo(qs) {
  const day = (qs.get('day') || '').toLowerCase().slice(0, 3), at = qs.get('at') || '';
  const okAt = /^([01]?\d|2[0-3]):[0-5]\d$/.test(at);
  if (!okAt && !DAY.includes(day)) return null;
  return { dow: DAY.includes(day) ? DAY.indexOf(day) : null, hm: okAt ? at.padStart(5, '0') : null };
}

/**
 * Next date with slots of `kind` ('basketball' | 'cheer'; omit/null = either). Today when today's weekday has them
 * (the screen keeps that day after the window ends); else the next date within 7 days; else today.
 * A weekday counts only when `days` has its hours and that kind has a slot. Keep in step with practiceDisplayOf.
 * -> { date, dow, today }.
 */
export function practiceDisplayDay(data, kind, today, todayDow) {
  const lists = kind ? [data?.[kind] || []] : [data?.basketball || [], data?.cheer || []];
  const open = new Set((data?.days || []).map((d) => Number(d.day)));
  const has = (dow) => open.has(dow) && lists.some((l) => l.some((x) => Number(x.day) === dow));
  const n = Number(todayDow);
  const dow0 = Number.isInteger(n) ? ((n % 7) + 7) % 7 : 0;
  for (let k = 0; k <= 7; k++) {
    const dow = (dow0 + k) % 7;
    if (has(dow)) return { date: addDays(today, k), dow, today: k === 0 };
  }
  return { date: today, dow: dow0, today: true };
}

/** Next practice text for the idle screen: "Next practice: Mon 5:00 PM" (null if there are no practice days). */
export function nextPracticeText(data, kind, dow, nowHm) {
  const has = (d) => (kind === 'cheer' ? data.cheer : data.basketball).some((x) => x.day === d.day);
  const days = (data.days || []).filter(has);
  for (let k = 0; k < 8; k++) {
    const d = days.find((x) => x.day === (dow + k) % 7);
    if (d && (k > 0 || toMin(nowHm) < toMin(d.end))) return `Next practice: ${k === 0 ? 'Today' : SHORT[d.day]} ${ampm(d.start)}`;
  }
  return null;
}

/**
 * plan(data, kind, dow, nowHm, mode?) -> { mode: 'practice'|'idle', day, header, pages, current, startsText }
 *   basketball pages: [{ time, courts: { west1: entry|null, ... } }]; cheer pages: [[entry, ...] up to 9].
 *   mode omitted: idle outside 60 min before .. 15 min after (demo ?day= / ?at=).
 *   'hold': today stays up all day — before the window is the preview ("Starts 5:00 PM"); after it, the last slot
 *   stays up so the footer reads "Last practice slot tonight".
 *   'future': that weekday's preview at any clock time ("Starts Monday 5:00 PM"), no current slot.
 */
export function planPractice(data, kind, dow, nowHm, mode) {
  const d = (data.days || []).find((x) => x.day === dow);
  const items = d ? (kind === 'cheer' ? data.cheer : data.basketball).filter((x) => x.day === dow) : [];
  const idle = { mode: 'idle', day: DAY[dow], header: kind === 'cheer' ? 'CHEER PRACTICE' : 'BASKETBALL PRACTICE', pages: [], next: nextPracticeText(data, kind, dow, nowHm) };
  if (!d || !items.length) return idle;
  const n = toMin(nowHm), s = toMin(d.start), e = toMin(d.end);
  const before = n < s - PRE_MIN, after = n >= e + POST_MIN;
  const future = mode === 'future', hold = mode === 'hold';
  if ((before || after) && !future && !hold) return idle;
  const cheerPages = () => { const pages = []; for (let i = 0; i < items.length; i += CHEER_PER_PAGE) pages.push(items.slice(i, i + CHEER_PER_PAGE)); return pages; };
  const ballPages = () => slotStarts(d.start, d.end).map((time) => ({ time, courts: Object.fromEntries(COURTS.map((c) => [c, items.find((x) => x.start === time && x.court === c) || null])) }));
  const built = kind === 'cheer'
    ? { day: DAY[dow], header: `${LONG[dow]} CHEER`, pages: cheerPages() }
    : { day: DAY[dow], header: LONG[dow], pages: ballPages() };
  // Future day, or today still before the 60-minute window: page every slot, nothing is current.
  if (future || (hold && before)) {
    const startsText = future ? `Starts ${TITLE[dow]} ${ampm(d.start)}` : `Starts ${ampm(d.start)}`;
    return { mode: 'practice', ...built, current: null, startsText };
  }
  // Today, after the window: keep the day on screen. Basketball pins the last slot ("Last practice slot tonight").
  if (hold && after) {
    const current = kind === 'cheer' ? null : (built.pages.length ? built.pages.length - 1 : null);
    return { mode: 'practice', ...built, current, startsText: null };
  }
  const startsText = n < s ? `Starts ${ampm(d.start)}` : null;
  if (kind === 'cheer') return { mode: 'practice', ...built, current: null, startsText };
  let current = -1; built.pages.forEach((p, i) => { if (toMin(p.time) - EARLY_MIN <= n) current = i; });
  if (current >= 0 && n >= e) current = built.pages.length - 1;
  return { mode: 'practice', ...built, current: current >= 0 ? current : null, startsText };
}

/** Which page shows at second `t` of the rotation: { index, state: 'current'|'next'|'all' }. */
export function rotation(plan, t) {
  const n = plan.pages.length;
  if (!n) return { index: 0, state: 'all' };
  if (plan.current == null) return { index: Math.floor(t / PAGE_S) % n, state: 'all' };
  const hasNext = plan.current + 1 < n;
  if (!hasNext) return { index: plan.current, state: 'current' };
  return (t % (PAGE_S + NEXT_S)) < PAGE_S ? { index: plan.current, state: 'current' } : { index: plan.current + 1, state: 'next' };
}
