// Pure, server-authoritative game-state reducer. No I/O here: easy to test.
// Clock model: {running, remainingMs, startedAt}. Every screen derives the
// displayed time from server timestamps, so nobody "ticks" and nothing drifts.

export type Side = 'home' | 'away';

export interface Rules {
  periods: number;          // regulation periods; the game is split into two halves of ceil(periods/2)
  periodLengthMs: number;   // e.g. 8 min
  timeoutsPerGame: number;  // legacy per-game allotment (used when timeoutsPerHalf is not set)
  /** Timeouts per half, refilled at halftime (2026-10). Unset/0 = legacy per-game timeouts. */
  timeoutsPerHalf?: number;
  bonusFouls: number;       // team fouls at which the OPPONENT is in the bonus
  foulReset: 'period' | 'half' | 'game';
}

/**
 * League rules (2026-10): 6 periods of 6 minutes (36-minute game) = two halves of 3, halftime after period 3.
 * Fouls reset at halftime (bonus is per half); timeouts are per half (2) and refill at halftime.
 * Overtime (period 7+) continues the 2nd half: fouls and remaining timeouts carry over.
 */
export const DEFAULT_RULES: Rules = {
  periods: 6,
  periodLengthMs: 6 * 60_000, // 6-minute periods = 36-minute game (2026-10)
  timeoutsPerGame: 4,
  timeoutsPerHalf: 2,
  bonusFouls: 7,
  foulReset: 'half',
};

/** Periods in the first half (halftime comes after this period). */
export const periodsPerHalf = (r: Pick<Rules, 'periods'>) => Math.ceil(r.periods / 2);
/** Timeouts a team can hold: per half when timeoutsPerHalf is set, else per game (legacy). */
export const timeoutCap = (r: Rules) => (r.timeoutsPerHalf && r.timeoutsPerHalf > 0 ? r.timeoutsPerHalf : r.timeoutsPerGame);

/**
 * The one period label used on every screen (TV, overlay, scorekeeper, lobby; mirrored in public/common.js):
 * "1st Half · P2", "2nd Half · P5", "OT", "OT2". Periods are numbered P1..P6 across the game.
 */
export function periodLabel(p: number, periods: number): string {
  if (!p) return '';
  if (p > periods) return `OT${p - periods > 1 ? p - periods : ''}`;
  return `${p <= Math.ceil(periods / 2) ? '1st' : '2nd'} Half · P${p}`;
}

export interface TeamState { score: number; fouls: number; timeoutsLeft: number; }

export interface Clock { running: boolean; remainingMs: number; startedAt: number | null; }

export interface GameState {
  seq: number;              // increments on every accepted change
  status: 'scheduled' | 'active' | 'complete';
  period: number;
  clock: Clock;
  home: TeamState;
  away: TeamState;
  possession: Side | null;
  banner: string | null;    // e.g. "HALFTIME", shown on the TV
  rules: Rules;
  lastLabel: string | null; // human label of last change, for the Undo button
  /** Snapshot taken when "Next period" was pressed, so an accidental Next can be reversed with Prev. */
  beforeNext?: { period: number; homeFouls: number; awayFouls: number; remainingMs: number; homeTimeouts?: number; awayTimeouts?: number; banner?: string | null } | null;
}

export type Command =
  | { type: 'SCORE'; team: Side; pts: number }      // +1/+2/+3 or negative correction
  | { type: 'FOUL'; team: Side; delta: number }
  | { type: 'TIMEOUT'; team: Side; delta: number }  // delta -1 = use a timeout
  | { type: 'CLOCK_START' }
  | { type: 'CLOCK_STOP' }
  | { type: 'CLOCK_ADJUST'; ms: number }
  | { type: 'CLOCK_SET'; ms: number }
  | { type: 'CLOCK_EXPIRE' }                        // system: clock hit 0
  | { type: 'PERIOD'; delta: number }
  | { type: 'POSSESSION'; team: Side | 'toggle' | null }
  | { type: 'BANNER'; text: string | null }
  | { type: 'START_GAME' }
  | { type: 'END_GAME' }
  | { type: 'REOPEN' };

export interface History { present: GameState; past: GameState[]; future: GameState[]; }

export const HISTORY_LIMIT = 100;

export function initialState(rules: Partial<Rules> = {}): GameState {
  const r = { ...DEFAULT_RULES, ...rules };
  const team = (): TeamState => ({ score: 0, fouls: 0, timeoutsLeft: timeoutCap(r) });
  return {
    seq: 0, status: 'scheduled', period: 1,
    clock: { running: false, remainingMs: r.periodLengthMs, startedAt: null },
    home: team(), away: team(), possession: null, banner: null, rules: r, lastLabel: null,
  };
}

export function remainingMs(clock: Clock, now: number): number {
  if (!clock.running || clock.startedAt == null) return Math.max(0, clock.remainingMs);
  return Math.max(0, clock.remainingMs - (now - clock.startedAt));
}

/** Freeze the clock at its current value (used before any clock edit). */
function frozen(clock: Clock, now: number): Clock {
  return { running: false, remainingMs: remainingMs(clock, now), startedAt: null };
}

export function isBonus(s: GameState, side: Side): boolean {
  // side is "in the bonus" when the opponent has reached the threshold
  const opp = side === 'home' ? s.away : s.home;
  return opp.fouls >= s.rules.bonusFouls;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const name = (t: Side) => (t === 'home' ? 'Home' : 'Away');

/** Score, foul and timeout commands: not allowed on score-hidden (K-2nd) games. */
export function isTeamStatCommand(c: { type: string }): boolean {
  return c.type === 'SCORE' || c.type === 'FOUL' || c.type === 'TIMEOUT';
}
/** True if an undo/redo label is a score/foul/timeout change ("Home +2", "Away foul +1", "Home timeout"). */
export function isTeamStatLabel(label: string | null | undefined): boolean {
  return /^(Home|Away) /.test(label ?? '');
}
/**
 * For a score-hidden game: null if the scorekeeper message may run, else the refusal text. Undo/Redo stay
 * available for clock, period and possession changes, but may not undo or redo a score/foul/timeout change.
 */
export function hiddenGameRefusal(msgType: 'cmd' | 'undo' | 'redo', cmd: { type: string } | null, h: History): string | null {
  const why = 'Scores, fouls and timeouts are not kept for K–2nd Grade games (clock, period and possession only).';
  if (msgType === 'cmd') return cmd && isTeamStatCommand(cmd) ? why : null;
  const target = msgType === 'undo' ? (h.past.length ? h.present.lastLabel : null) : h.future[0]?.lastLabel;
  return isTeamStatLabel(target) ? why : null;
}

export function isClockCommand(c: Command): boolean {
  return c.type.startsWith('CLOCK_');
}

/** Apply one command. Returns the same object if the command was a no-op. */
export function apply(s: GameState, c: Command, now: number): GameState {
  const next = structuredClone(s) as GameState;
  let label: string;
  switch (c.type) {
    case 'SCORE': {
      const t = next[c.team];
      const v = Math.max(0, t.score + Math.trunc(c.pts));
      if (v === t.score) return s;
      t.score = v; label = `${name(c.team)} ${c.pts > 0 ? '+' : ''}${c.pts}`; break;
    }
    case 'FOUL': {
      const t = next[c.team];
      const v = Math.max(0, t.fouls + Math.trunc(c.delta));
      if (v === t.fouls) return s;
      t.fouls = v; label = `${name(c.team)} foul ${c.delta > 0 ? '+1' : '-1'}`; break;
    }
    case 'TIMEOUT': {
      const t = next[c.team];
      const v = clamp(t.timeoutsLeft + Math.trunc(c.delta), 0, timeoutCap(s.rules));
      if (v === t.timeoutsLeft) return s;
      t.timeoutsLeft = v;
      if (c.delta < 0) next.clock = frozen(next.clock, now); // timeout stops the clock
      label = `${name(c.team)} timeout`; break;
    }
    case 'CLOCK_START':
      if (s.clock.running || remainingMs(s.clock, now) <= 0) return s;
      next.clock = { running: true, remainingMs: s.clock.remainingMs, startedAt: now };
      if (next.status === 'scheduled') next.status = 'active';
      next.banner = null; label = 'Clock start'; break;
    case 'CLOCK_STOP':
      if (!s.clock.running) return s;
      next.clock = frozen(s.clock, now); label = 'Clock stop'; break;
    case 'CLOCK_EXPIRE':
      if (!s.clock.running || remainingMs(s.clock, now) > 0) return s;
      next.clock = { running: false, remainingMs: 0, startedAt: null }; label = 'End of period';
      if (s.period === periodsPerHalf(s.rules)) next.banner = 'HALFTIME'; // end of the 1st half (P3 by default)
      break;
    case 'CLOCK_ADJUST': {
      const f = frozen(s.clock, now);
      const v = clamp(f.remainingMs + c.ms, 0, s.rules.periodLengthMs);
      next.clock = s.clock.running && v > 0 ? { running: true, remainingMs: v, startedAt: now } : { ...f, remainingMs: v };
      label = `Clock ${c.ms > 0 ? '+' : ''}${Math.round(c.ms / 1000)}s`; break;
    }
    case 'CLOCK_SET':
      next.clock = { running: false, remainingMs: clamp(Math.trunc(c.ms), 0, s.rules.periodLengthMs), startedAt: null };
      label = 'Clock set'; break;
    case 'PERIOD': {
      const p = clamp(s.period + Math.trunc(c.delta), 1, s.rules.periods + 4); // allow overtime
      if (p === s.period) return s;
      next.period = p;
      next.clock = { running: false, remainingMs: s.rules.periodLengthMs, startedAt: null };
      const back = c.delta < 0 && s.beforeNext && s.beforeNext.period === p ? s.beforeNext : null;
      const half = periodsPerHalf(s.rules);
      const intoSecondHalf = c.delta > 0 && s.period <= half && p > half;
      const reset = s.rules.foulReset === 'period' || (s.rules.foulReset === 'half' && intoSecondHalf);
      if (reset) { next.home.fouls = 0; next.away.fouls = 0; }
      if (intoSecondHalf) {
        if (s.rules.timeoutsPerHalf) next.home.timeoutsLeft = next.away.timeoutsLeft = timeoutCap(s.rules); // refill at halftime
        next.banner = 'HALFTIME'; // shown until the 2nd half clock starts
      }
      else if (s.banner === 'HALFTIME') next.banner = null; // any other period change drops a stale HALFTIME
      if (c.delta > 0) next.beforeNext = { period: s.period, homeFouls: s.home.fouls, awayFouls: s.away.fouls, remainingMs: remainingMs(s.clock, now),
        homeTimeouts: s.home.timeoutsLeft, awayTimeouts: s.away.timeoutsLeft, banner: s.banner };
      if (back) { // Prev right after Next: bring back that period's fouls, timeouts and clock (QA #11)
        next.home.fouls = back.homeFouls; next.away.fouls = back.awayFouls;
        if (back.homeTimeouts != null) next.home.timeoutsLeft = back.homeTimeouts;
        if (back.awayTimeouts != null) next.away.timeoutsLeft = back.awayTimeouts;
        if (back.banner !== undefined) next.banner = back.banner;
        next.clock = { running: false, remainingMs: back.remainingMs, startedAt: null };
      }
      if (c.delta < 0) next.beforeNext = null;
      label = `Period ${p}`; break;
    }
    case 'POSSESSION': {
      const v = c.team === 'toggle' ? (s.possession === 'home' ? 'away' : 'home') : c.team;
      if (v === s.possession) return s;
      next.possession = v; label = 'Possession'; break;
    }
    case 'BANNER':
      next.banner = c.text ? String(c.text).slice(0, 40) : null; label = 'Banner'; break;
    case 'START_GAME':
      if (s.status !== 'scheduled') return s;
      next.status = 'active'; label = 'Game started'; break;
    case 'END_GAME':
      if (s.status === 'complete') return s;
      next.clock = frozen(s.clock, now); next.status = 'complete'; next.banner = 'FINAL'; label = 'Game completed'; break;
    case 'REOPEN': // admin only (the server never accepts it from a scorekeeper)
      if (s.status !== 'complete') return s;
      next.status = 'active'; next.banner = null; label = 'Game reopened'; break;
    default:
      throw new Error('Unknown command');
  }
  next.seq = s.seq + 1;
  next.lastLabel = label;
  return next;
}

// ---- Undo / redo over full snapshots -------------------------------------
// Undoing a scoring/foul change must not rewind the running clock, so the
// live clock is kept unless the change being undone was itself a clock edit.

export function newHistory(state: GameState): History { return { present: state, past: [], future: [] }; }

export function dispatch(h: History, c: Command, now: number): History {
  const n = apply(h.present, c, now);
  if (n === h.present) return h;
  // System event, not undoable: keep the Undo label pointing at the real top of the history (QA #7).
  if (c.type === 'CLOCK_EXPIRE') return { ...h, present: { ...n, lastLabel: h.present.lastLabel } };
  return { present: n, past: [...h.past, h.present].slice(-HISTORY_LIMIT), future: [] };
}

function restore(target: GameState, current: GameState, keepClock: boolean, label: string): GameState {
  const r = structuredClone(target) as GameState;
  if (keepClock) r.clock = current.clock;
  r.seq = current.seq + 1; // seq is monotonic so clients always accept it
  r.lastLabel = label;
  return r;
}

export function undo(h: History, _now: number): History {
  const prev = h.past[h.past.length - 1];
  if (!prev) return h;
  const undoneWasClock = /^Clock/.test(h.present.lastLabel ?? '');
  const present = restore(prev, h.present, !undoneWasClock, `Undo ${h.present.lastLabel ?? ''}`.trim());
  present.lastLabel = prev.lastLabel; // so the button shows the next thing to undo
  return { present, past: h.past.slice(0, -1), future: [h.present, ...h.future] };
}

export function redo(h: History, _now: number): History {
  const nxt = h.future[0];
  if (!nxt) return h;
  const isClock = /^Clock/.test(nxt.lastLabel ?? '');
  const present = restore(nxt, h.present, !isClock, nxt.lastLabel ?? 'Redo');
  return { present, past: [...h.past, h.present], future: h.future.slice(1) };
}

const SIDES = ['home', 'away'];
/** Validate untrusted input from the network into a Command (or throw). */
export function parseCommand(x: any): Command {
  if (!x || typeof x.type !== 'string') throw new Error('bad command');
  const num = (v: any) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error('bad number'); return n; };
  const side = (v: any) => { if (!SIDES.includes(v)) throw new Error('bad team'); return v as Side; };
  switch (x.type) {
    case 'SCORE': { const pts = num(x.pts); if (![1, 2, 3, -1, -2, -3].includes(pts)) throw new Error('bad pts'); return { type: 'SCORE', team: side(x.team), pts }; }
    case 'FOUL': return { type: 'FOUL', team: side(x.team), delta: num(x.delta) >= 0 ? 1 : -1 };
    case 'TIMEOUT': return { type: 'TIMEOUT', team: side(x.team), delta: num(x.delta) >= 0 ? 1 : -1 };
    case 'CLOCK_START': case 'CLOCK_STOP': case 'START_GAME': case 'END_GAME': return { type: x.type };
    case 'CLOCK_ADJUST': return { type: 'CLOCK_ADJUST', ms: clamp(num(x.ms), -600_000, 600_000) };
    case 'CLOCK_SET': return { type: 'CLOCK_SET', ms: num(x.ms) };
    case 'PERIOD': return { type: 'PERIOD', delta: num(x.delta) >= 0 ? 1 : -1 };
    case 'POSSESSION': return { type: 'POSSESSION', team: x.team === 'toggle' || x.team === null ? x.team : side(x.team) };
    case 'BANNER': return { type: 'BANNER', text: x.text == null ? null : String(x.text) };
    default: throw new Error('unknown command');
  }
}

/** Older builds used 'live'/'final'; map stored histories to 'active'/'complete'. */
export function normalizeStatus<T>(h: T): T {
  const fix = (st: any) => { if (st && st.status === 'live') st.status = 'active'; else if (st && st.status === 'final') st.status = 'complete'; };
  const x: any = h; if (!x) return h;
  fix(x.present); (x.past || []).forEach(fix); (x.future || []).forEach(fix);
  return h;
}
