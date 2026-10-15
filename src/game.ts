// Pure, server-authoritative game-state reducer. No I/O here: easy to test.
// Clock model: {running, remainingMs, startedAt}. Every screen derives the
// displayed time from server timestamps, so nobody "ticks" and nothing drifts.

export type Side = 'home' | 'away';

export interface Rules {
  periods: number;          // e.g. 4 quarters or 2 halves
  periodLengthMs: number;   // e.g. 8 min
  timeoutsPerGame: number;
  bonusFouls: number;       // team fouls at which the OPPONENT is in the bonus
  foulReset: 'period' | 'half' | 'game';
}

export const DEFAULT_RULES: Rules = {
  periods: 4,
  periodLengthMs: 8 * 60_000,
  timeoutsPerGame: 3,
  bonusFouls: 7,
  foulReset: 'half',
};

export interface TeamState { score: number; fouls: number; timeoutsLeft: number; }

export interface Clock { running: boolean; remainingMs: number; startedAt: number | null; }

export interface GameState {
  seq: number;              // increments on every accepted change
  status: 'scheduled' | 'live' | 'final';
  period: number;
  clock: Clock;
  home: TeamState;
  away: TeamState;
  possession: Side | null;
  banner: string | null;    // e.g. "HALFTIME", shown on the TV
  rules: Rules;
  lastLabel: string | null; // human label of last change, for the Undo button
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
  | { type: 'END_GAME' };

export interface History { present: GameState; past: GameState[]; future: GameState[]; }

export const HISTORY_LIMIT = 100;

export function initialState(rules: Partial<Rules> = {}): GameState {
  const r = { ...DEFAULT_RULES, ...rules };
  const team = (): TeamState => ({ score: 0, fouls: 0, timeoutsLeft: r.timeoutsPerGame });
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
      const v = clamp(t.timeoutsLeft + Math.trunc(c.delta), 0, s.rules.timeoutsPerGame);
      if (v === t.timeoutsLeft) return s;
      t.timeoutsLeft = v;
      if (c.delta < 0) next.clock = frozen(next.clock, now); // timeout stops the clock
      label = `${name(c.team)} timeout`; break;
    }
    case 'CLOCK_START':
      if (s.clock.running || remainingMs(s.clock, now) <= 0) return s;
      next.clock = { running: true, remainingMs: s.clock.remainingMs, startedAt: now };
      if (next.status === 'scheduled') next.status = 'live';
      next.banner = null; label = 'Clock start'; break;
    case 'CLOCK_STOP':
      if (!s.clock.running) return s;
      next.clock = frozen(s.clock, now); label = 'Clock stop'; break;
    case 'CLOCK_EXPIRE':
      if (!s.clock.running || remainingMs(s.clock, now) > 0) return s;
      next.clock = { running: false, remainingMs: 0, startedAt: null }; label = 'End of period'; break;
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
      const half = Math.ceil(s.rules.periods / 2);
      const reset = s.rules.foulReset === 'period' ||
        (s.rules.foulReset === 'half' && c.delta > 0 && s.period <= half && p > half);
      if (reset) { next.home.fouls = 0; next.away.fouls = 0; }
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
      next.status = 'live'; label = 'Game started'; break;
    case 'END_GAME':
      if (s.status === 'final') return s;
      next.clock = frozen(s.clock, now); next.status = 'final'; next.banner = 'FINAL'; label = 'Game ended'; break;
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
  if (c.type === 'CLOCK_EXPIRE') return { ...h, present: n }; // system event, not undoable
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
