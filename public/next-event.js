// Next scheduled event for the idle screens (lobby + both practice TVs): whichever comes first, the next game day
// (date, first tip-off) or the next practice night (Mon–Thu, its start time). Pure, testable.
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const ampm = (t) => { const [h, m] = String(t).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const dowOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * nextEvent({ today 'YYYY-MM-DD', now 'HH:MM', gameDays [{date, first}], practice { days [{day, start, end}], basketball, cheer }, kind? })
 * -> { type: 'game'|'practice', date, time } | null. A game day counts while its first tip-off is still ahead; a
 * practice night counts until it ends (today) and only if it has slots (of `kind` when given: 'basketball'|'cheer').
 * Ties (same date + time) go to the game.
 */
export function nextEvent({ today, now = '00:00', gameDays = [], practice = null, kind = null }) {
  const n = toMin(now);
  const g = (gameDays || []).filter((d) => d.date > today || (d.date === today && toMin(d.first) > n)).sort((a, b) => (a.date + a.first < b.date + b.first ? -1 : 1))[0];
  const game = g ? { type: 'game', date: g.date, time: g.first } : null;
  let prac = null;
  if (practice) {
    const lists = kind ? [practice[kind] || []] : [practice.basketball || [], practice.cheer || []];
    const has = (day) => lists.some((l) => l.some((x) => x.day === day));
    for (let k = 0; k < 8 && !prac; k++) {
      const date = addDays(today, k), d = (practice.days || []).find((x) => x.day === dowOf(date));
      if (d && has(d.day) && (k > 0 || n < toMin(d.end))) prac = { type: 'practice', date, time: d.start };
    }
  }
  if (!game) return prac;
  if (!prac) return game;
  return prac.date + prac.time < game.date + game.time ? prac : game;
}

/** "Next: Games Saturday, Oct 24 · First tip-off 9:00 AM" / "Next: Practice Monday, Oct 26 · 5:00 PM" / "No games or practices scheduled". */
export function nextEventText(ev, today) {
  if (!ev) return 'No games or practices scheduled';
  const [, mo, dd] = ev.date.split('-').map(Number);
  const when = ev.date === today ? 'Today' : `${LONG[dowOf(ev.date)]}, ${MON[mo - 1]} ${dd}`;
  return ev.type === 'game' ? `Next: Games ${when} · First tip-off ${ampm(ev.time)}` : `Next: Practice ${when} · ${ampm(ev.time)}`;
}
export { SHORT };
