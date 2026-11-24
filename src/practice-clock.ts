// Release 2: basketball practice-night countdown clocks (pure logic, no DB).
// Every court TV (without an active game) switches to practice mode at each scheduled
// basketball practice slot with DEVO (25:00) and PRACTICE ENDS (60:00) running together.
import { COURTS, PRange, practiceDisplayOf, slotStarts } from './practice.js';
import { LEAGUE_TZ, dowOf, localDate } from './schedule.js';

export const DEVO_MS = 25 * 60_000;
export const END_MS = 60 * 60_000;
export const LAST_SLOT_CAP_MS = 3 * 60 * 60_000;
export const PRACTICE_BUZZ_MS = 5_000;
export const STALE_BUZZ_MS = 2_000;
export const PRACTICE_CLOCK_KEY = 'practice_clock';

export interface PracticeBasketballEntry {
  day: number;
  start: string;
  court: string;
  teamId?: number;
  team: { name: string; [key: string]: unknown };
}

export interface PracticeData {
  days: { day: number; start: string; end: string }[];
  basketball: PracticeBasketballEntry[];
  cheer?: { day: number; [key: string]: unknown }[];
  range?: PRange | null;
}

export interface PracticeSlot {
  date: string;
  start: string;
  slotKey: string;
  startMs: number;
  label: string;
  teams: string[];
}

export interface PracticeClockControl {
  slotKey: string;
  restartAt: number | null;
  pausedAt: number | null;
  pausedMs: number;
}

export interface ClockView {
  running: boolean;
  remainingMs: number;
  startedAt: number | null;
}

export interface PracticeView {
  slot: { date: string; start: string };
  label: string;
  teams: string[];
  paused: boolean;
  devo: ClockView;
  end: ClockView;
}

export interface CurrentPractice {
  slot: PracticeSlot;
  nextSlot: PracticeSlot | null;
  control: PracticeClockControl;
  view: PracticeView;
}

export interface PracticeBuzzEvent {
  reason: 'practice-devo' | 'practice-end';
  key: string;
  slotKey: string;
  zeroAt: number;
}

/** "17:00" -> "5:00 PM", "16:30" -> "4:30 PM". */
export function formatSlotLabel(hm: string): string {
  const [h, m] = String(hm).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Local wall-clock components of an epoch instant in `tz`, returned as a UTC epoch ms value. */
function wallClockAsUtcMs(epochMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'), 0);
}

/**
 * Convert league-local date ('YYYY-MM-DD') + time ('HH:MM') in `tz` to exact epoch ms.
 * Handles CST/CDT and DST transition days via a two-pass offset adjustment.
 */
export function leagueEpochMs(date: string, hm: string, tz = LEAGUE_TZ): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const targetUtc = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  const offset1 = targetUtc - wallClockAsUtcMs(targetUtc, tz);
  const candidate = targetUtc + offset1;
  const offset2 = candidate - wallClockAsUtcMs(candidate, tz);
  return targetUtc + offset2;
}

/**
 * Active basketball practice slots for a league-local date ('YYYY-MM-DD').
 * Returns [] if today is not a basketball practice day (or outside season range).
 * Empty 1-hour slots (0 teams) are omitted. Teams are ordered west1, west2, east1, east2.
 */
export function slotsForDate(data: PracticeData | null | undefined, date: string, tz = LEAGUE_TZ): PracticeSlot[] {
  if (!data) return [];
  const dow = dowOf(date);
  const disp = practiceDisplayOf(data, 'basketball', date, dow);
  if (!disp.today || disp.over) return [];
  const dayRow = (data.days || []).find((d) => Number(d.day) === dow);
  if (!dayRow) return [];
  const dayBall = (data.basketball || []).filter((b) => Number(b.day) === dow);
  if (!dayBall.length) return [];

  const out: PracticeSlot[] = [];
  for (const start of slotStarts(dayRow.start, dayRow.end)) {
    const inSlot = dayBall.filter((b) => b.start === start);
    const teams = COURTS
      .map((court) => inSlot.find((b) => b.court === court)?.team?.name)
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
    if (!teams.length) continue;
    out.push({
      date,
      start,
      slotKey: `${date} ${start}`,
      startMs: leagueEpochMs(date, start, tz),
      label: formatSlotLabel(start),
      teams,
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Parse and validate a stored JSON control payload without checking slotKey. Returns null on invalid input. */
export function parsePracticeControlRaw(raw: unknown): PracticeClockControl | null {
  if (raw == null || raw === '') return null;
  let obj: any = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.slotKey !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(obj.slotKey)) return null;
  const okNumOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
  if (!okNumOrNull(obj.restartAt) || !okNumOrNull(obj.pausedAt)) return null;
  if (typeof obj.pausedMs !== 'number' || !Number.isFinite(obj.pausedMs) || obj.pausedMs < 0) return null;
  return {
    slotKey: obj.slotKey,
    restartAt: obj.restartAt,
    pausedAt: obj.pausedAt,
    pausedMs: obj.pausedMs,
  };
}

/** Apply a stored control only when valid and scoped to `expectedSlotKey`; otherwise return null (ignore). */
export function applyStoredControl(raw: unknown, expectedSlotKey: string | null): PracticeClockControl | null {
  if (!expectedSlotKey) return null;
  const parsed = parsePracticeControlRaw(raw);
  return parsed && parsed.slotKey === expectedSlotKey ? parsed : null;
}

/** Return the matching control for `slotKey`, or a fresh unpaused control if absent or from another slot. */
export function controlForSlot(slotKey: string, control: PracticeClockControl | null | undefined): PracticeClockControl {
  if (control && control.slotKey === slotKey) return control;
  return { slotKey, restartAt: null, pausedAt: null, pausedMs: 0 };
}

/** Compute DEVO and END clock states at `nowMs`. */
export function computePracticeClocks(
  startMs: number,
  control: PracticeClockControl,
  nowMs: number,
): { paused: boolean; elapsedMs: number; devo: ClockView; end: ClockView } {
  const anchor = control.restartAt ?? startMs;
  const paused = control.pausedAt !== null;
  const activePauseMs = control.pausedAt !== null ? Math.max(0, nowMs - control.pausedAt) : 0;
  const elapsedMs = Math.max(0, nowMs - anchor - control.pausedMs - activePauseMs);
  const devoRem = Math.max(0, DEVO_MS - elapsedMs);
  const endRem = Math.max(0, END_MS - elapsedMs);
  const makeClock = (rem: number): ClockView =>
    !paused && rem > 0
      ? { running: true, remainingMs: rem, startedAt: nowMs }
      : { running: false, remainingMs: rem, startedAt: null };
  return {
    paused,
    elapsedMs,
    devo: makeClock(devoRem),
    end: makeClock(endRem),
  };
}

/** Idempotent pause transition for the current slot. */
export function pausePracticeControl(
  slotKey: string,
  control: PracticeClockControl | null | undefined,
  nowMs: number,
): PracticeClockControl {
  const ctrl = controlForSlot(slotKey, control);
  if (ctrl.pausedAt !== null) return ctrl;
  return { ...ctrl, pausedAt: nowMs };
}

/** Idempotent resume transition for the current slot. */
export function resumePracticeControl(
  slotKey: string,
  control: PracticeClockControl | null | undefined,
  nowMs: number,
): PracticeClockControl {
  const ctrl = controlForSlot(slotKey, control);
  if (ctrl.pausedAt === null) return ctrl;
  const added = Math.max(0, nowMs - ctrl.pausedAt);
  return { ...ctrl, pausedAt: null, pausedMs: ctrl.pausedMs + added };
}

/** Restart both clocks from `nowMs`, unpaused. */
export function restartPracticeControl(slotKey: string, nowMs: number): PracticeClockControl {
  return { slotKey, restartAt: nowMs, pausedAt: null, pausedMs: 0 };
}

/**
 * Current active basketball practice slot + view at `nowMs`, or null outside practice hours.
 * - Starts at exact slot start (EARLY_MIN is NOT used).
 * - Ends when END reaches 0, when the next active slot starts, or at start + 3 h cap.
 */
export function currentPractice(
  data: PracticeData | null | undefined,
  nowMs: number,
  control: PracticeClockControl | null | undefined = null,
  tz = LEAGUE_TZ,
): CurrentPractice | null {
  const today = localDate(nowMs, tz);
  const slots = slotsForDate(data, today, tz);
  if (!slots.length) return null;

  let idx = -1;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].startMs <= nowMs) idx = i;
  }
  if (idx < 0) return null;

  const slot = slots[idx];
  const nextSlot = slots[idx + 1] ?? null;
  if (nowMs >= slot.startMs + LAST_SLOT_CAP_MS) return null;

  const ctrl = controlForSlot(slot.slotKey, control);
  const clocks = computePracticeClocks(slot.startMs, ctrl, nowMs);
  if (clocks.end.remainingMs <= 0) return null;

  return {
    slot,
    nextSlot,
    control: ctrl,
    view: {
      slot: { date: slot.date, start: slot.start },
      label: slot.label,
      teams: slot.teams,
      paused: clocks.paused,
      devo: clocks.devo,
      end: clocks.end,
    },
  };
}

/**
 * Return any DEVO / END zero-crossings that just occurred within `[nowMs - STALE_BUZZ_MS, nowMs]`
 * and have not yet been fired (tracked by `firedKeys`).
 * Checks all active slots of today so an END crossing at a 1-hour boundary or after the last slot is never missed.
 */
export function dueBuzzEvents(
  data: PracticeData | null | undefined,
  nowMs: number,
  control: PracticeClockControl | null | undefined,
  firedKeys: ReadonlySet<string>,
  tz = LEAGUE_TZ,
): PracticeBuzzEvent[] {
  const today = localDate(nowMs, tz);
  const slots = slotsForDate(data, today, tz);
  const events: PracticeBuzzEvent[] = [];

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const nextSlot = slots[i + 1] ?? null;
    const hardEnd = Math.min(nextSlot ? nextSlot.startMs : Infinity, slot.startMs + LAST_SLOT_CAP_MS);
    const ctrl = controlForSlot(slot.slotKey, control);
    if (ctrl.pausedAt !== null) continue;

    const origin = (ctrl.restartAt ?? slot.startMs) + ctrl.pausedMs;
    const restartTag = ctrl.restartAt ?? 0;

    const check = (reason: 'practice-devo' | 'practice-end', durationMs: number) => {
      const zeroAt = origin + durationMs;
      if (zeroAt > hardEnd) return;
      if (nowMs < zeroAt || nowMs - zeroAt > STALE_BUZZ_MS) return;
      const key = `${slot.slotKey}|${restartTag}|${reason === 'practice-devo' ? 'devo' : 'end'}`;
      if (firedKeys.has(key)) return;
      events.push({ reason, key, slotKey: slot.slotKey, zeroAt });
    };

    check('practice-devo', DEVO_MS);
    check('practice-end', END_MS);
  }

  return events.sort((a, b) => a.zeroAt - b.zeroAt);
}

/**
 * Epoch ms of the soonest upcoming practice event strictly after `nowMs` (slot start, DEVO 0, END 0, or 3 h cap),
 * or null if no further events remain today.
 */
export function nextPracticeEventAt(
  data: PracticeData | null | undefined,
  nowMs: number,
  control: PracticeClockControl | null | undefined = null,
  tz = LEAGUE_TZ,
): number | null {
  const today = localDate(nowMs, tz);
  const slots = slotsForDate(data, today, tz);
  if (!slots.length) return null;

  const candidates: number[] = [];
  for (const s of slots) {
    if (s.startMs > nowMs) candidates.push(s.startMs);
  }

  const cur = currentPractice(data, nowMs, control, tz);
  if (cur) {
    const hardEnd = Math.min(
      cur.nextSlot ? cur.nextSlot.startMs : Infinity,
      cur.slot.startMs + LAST_SLOT_CAP_MS,
    );
    if (Number.isFinite(hardEnd) && hardEnd > nowMs) candidates.push(hardEnd);
    if (cur.control.pausedAt === null) {
      const origin = (cur.control.restartAt ?? cur.slot.startMs) + cur.control.pausedMs;
      const devoZeroAt = origin + DEVO_MS;
      const endZeroAt = origin + END_MS;
      if (devoZeroAt > nowMs && devoZeroAt <= hardEnd) candidates.push(devoZeroAt);
      if (endZeroAt > nowMs && endZeroAt <= hardEnd) candidates.push(endZeroAt);
    }
  }

  if (!candidates.length) return null;
  return Math.min(...candidates);
}
