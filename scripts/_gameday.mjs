// Shared e2e helper: the next game day (Fri 10:00 league time) and a shifted test clock.
// Import it FIRST in a script. With SCOREBOARD_TEST_NOW set (scripts/run-e2e.sh sets it to nextGameDay() for the server,
// the seed and the script), this process's Date is shifted to the same instant, so "now" games are legal Fri game-hour
// games on any weekday. pinBrowserClock(ctx) moves a Playwright context's clock to the same time.
export const LEAGUE_TZ = 'America/Chicago';
const local = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: LEAGUE_TZ }).slice(0, 16).split(' '); // [YYYY-MM-DD, HH:MM]
/** League-local wall time -> epoch ms (handles CST/CDT). */
export function leagueTime(date, hm) {
  for (const off of ['-05:00', '-06:00']) { const t = Date.parse(`${date}T${hm}:00${off}`); const [d, h] = local(t); if (d === date && h === hm) return t; }
  throw new Error(`no league time ${date} ${hm}`);
}
/** The next Friday 10:00 league time strictly after fromMs (a legal Fri/Sat 08:00–21:00 game slot). */
export function nextGameDay(fromMs = Date.now()) {
  for (let i = 0; i <= 8; i++) {
    const [d] = local(fromMs + i * 86_400_000);
    if (new Date(`${d}T12:00:00Z`).getUTCDay() !== 5) continue;
    const t = leagueTime(d, '10:00'); if (t > fromMs) return new Date(t);
  }
  throw new Error('no Friday found');
}
/** Next Saturday (the day after nextGameDay) at hm league time, plus whole weeks. */
export function nextSaturday(hm = '15:00', weeks = 0, fromMs = Date.now()) {
  const [fri] = local(nextGameDay(fromMs).getTime()); const sat = new Date(Date.parse(`${fri}T12:00:00Z`) + (1 + 7 * weeks) * 86_400_000).toISOString().slice(0, 10);
  return new Date(leagueTime(sat, hm));
}
const raw = process.env.SCOREBOARD_TEST_NOW;
if (raw && process.env.SCOREBOARD_TEST_CLOCK !== '1') throw new Error('SCOREBOARD_TEST_NOW needs SCOREBOARD_TEST_CLOCK=1 (explicit test-clock opt-in)');
export const TEST_NOW = raw ? Date.parse(raw) : null;
if (TEST_NOW != null && !globalThis.__sbShifted) {
  const R = Date, off = TEST_NOW - R.now();
  globalThis.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(R.now() + off); } static now() { return R.now() + off; } };
  globalThis.__sbShifted = true;
} else if (TEST_NOW == null) {
  const [d, hm] = local(Date.now()); const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
  if (![5, 6].includes(dow) || hm < '08:00' || hm > '20:00') console.warn('  (note: now is outside Fri/Sat game hours; run via scripts/run-e2e.sh, which sets SCOREBOARD_TEST_NOW)');
}
/** Pin a Playwright browser context to this process's (possibly shifted) clock. */
export async function pinBrowserClock(ctx) { if (TEST_NOW != null) await ctx.clock.setSystemTime(new Date(Date.now())); }
