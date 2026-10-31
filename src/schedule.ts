// Shared-floor scheduling rules. One gym floor: Full, or West + East at the same time.
// A court lists the courts it can't run alongside (courts.conflicts_with, slugs); the rule is
// symmetric, so Full -> [west, east] is enough. West and East don't list each other, so they may overlap.
import { seasonConfig } from './season-config.js';

/** Default game length in minutes (start time + this = end). Env GAME_MINUTES; per-game games.duration_min overrides. */
export const GAME_MINUTES = (() => { const n = Number(process.env.GAME_MINUTES); return Number.isInteger(n) && n > 0 && n <= 600 ? n : 60; })();

/** Half-open intervals [start, start+min): back-to-back games (10:00-11:00 then 11:00) don't overlap. */
export const overlaps = (aStart: number, aMin: number, bStart: number, bMin: number) =>
  aStart < bStart + bMin * 60_000 && bStart < aStart + aMin * 60_000;

export type CourtRule = { slug: string; conflicts_with?: string[] | null };
export const courtsConflict = (a: CourtRule, b: CourtRule) =>
  a.slug !== b.slug && ((a.conflicts_with || []).includes(b.slug) || (b.conflicts_with || []).includes(a.slug));

/** Parse "west east" / "west;east" / "west,east" into a clean slug list. */
export const parseConflicts = (v: unknown): string[] => {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[\s;,]+/);
  return [...new Set(arr.map((s) => String(s).trim().toLowerCase()).filter((s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)))].sort();
};

// ---- Grades: teams are organized by grade, then name. A game must be within one grade.
export const GRADES = ['Kindergarten', '1st-2nd Grade', '3rd-4th Grade', '5th-6th Grade'] as const;
export const DIVISIONS = [
  'Kindergarten',
  '1st-2nd Grade Boys',
  '1st-2nd Grade Girls',
  '3rd-4th Grade Boys',
  '3rd-4th Grade Girls',
  '5th-6th Grade Boys',
  '5th-6th Grade Girls',
] as const;
const ORD = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
/** Combined grade bands: Kindergarten, 1st-2nd Grade, 3rd-4th Grade, 5th-6th Grade (single 1..6 map to their combined band; 7..12 -> Nth Grade). */
export function normalizeGrade(v: unknown): string | null {
  const t = String(v ?? '').trim(); if (!t) return null;
  if (/^(?:k|kg|kinder|kindergarten)(?:\s+grade)?(?:\s+(?:boys?|girls?|coed|mixed))?$/i.test(t)) return 'Kindergarten';
  if (/^(?:grades?\s*)?(?:(?:1(?:st)?|first)(?:\s*(?:[-–—/&]|to|and)\s*(?:2(?:nd)?|second))?|2(?:nd)?|second)(?:\s*grade)?$/i.test(t)) return '1st-2nd Grade';
  if (/^(?:grades?\s*)?(?:(?:3(?:rd)?|third)(?:\s*(?:[-–—/&]|to|and)\s*(?:4(?:th)?|fourth))?|4(?:th)?|fourth)(?:\s*grade)?$/i.test(t)) return '3rd-4th Grade';
  if (/^(?:grades?\s*)?(?:(?:5(?:th)?|fifth)(?:\s*(?:[-–—/&]|to|and)\s*(?:6(?:th)?|sixth))?|6(?:th)?|sixth)(?:\s*grade)?$/i.test(t)) return '5th-6th Grade';
  const m = /^(?:grade\s*)?(\d{1,2})(?:st|nd|rd|th)?(?:\s*grade)?$/i.exec(t);
  if (m && Number(m[1]) >= 7 && Number(m[1]) <= 12) return `${ORD(Number(m[1]))} Grade`;
  if (t.length > 30) throw Object.assign(new Error(`grade "${t.slice(0, 20)}…" is longer than 30 characters`), { status: 400 });
  return t;
}
/**
 * Score-hidden grades (K through 2nd), from any free-text grade: "K", "Kindergarten", "Pre-K", "PreK", "PK",
 * "1", "1st", "First", "2", "2nd", "Second", with or without "Grade"/"Gr"/"Grd", any case, spacing or punctuation
 * ("2nd Grade", " 1ST ", "Gr 2", "grade-1", "Grade: Second"). 3rd and above, unknown text and empty never match.
 * The one helper behind every score-hiding decision (server payloads + scorekeeper enforcement).
 */
export function isScoreHiddenGrade(v: unknown): boolean {
  const g = gradeNumbers(v);
  return !!g && g.length > 0 && Math.max(...g) <= 2;
}

const WORD_GRADE: Record<string, number> = { prek: -1, pk: -1, prekindergarten: -1, prekinder: -1, k: 0, kg: 0, kinder: 0, kindergarten: 0,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };
const NOISE = new Set(['grade', 'grades', 'gr', 'grd', 'boys', 'boy', 'girls', 'girl', 'coed', 'co', 'ed', 'mixed', 'division', 'div']);
/**
 * Grade(s) named in a free-text label, as numbers (Pre-K -1, K 0, 1..12), or null if any part isn't a grade.
 * NFKC + accents stripped, case/punctuation-insensitive; "Grade"/"Gr"/"Boys"/"Girls" ignored. Ranges and lists give
 * their ends ("K-2" -> [0, 2], "1st/2nd" -> [1, 2], "2nd/3rd" -> [2, 3]).
 */
export function gradeNumbers(v: unknown): number[] | null {
  const t = String(v ?? '').normalize('NFKC').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').replace(/\bpre (?=k)/g, 'pre').trim();
  const words = t.split(' ').filter((w) => w && !NOISE.has(w));
  if (!words.length) return null;
  const out: number[] = [];
  for (const w of words) {
    if (w in WORD_GRADE) { out.push(WORD_GRADE[w]); continue; }
    const m = /^0?(\d{1,2})(st|nd|rd|th)?$/.exec(w);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return null;
    out.push(Number(m[1]));
  }
  return out;
}

/** Sort key: Pre-K -1, Kindergarten 0, a single grade in any spelling ("2nd Grade", "Second", "Gr 2") N, other labels 99, none 100. */
export function gradeOrder(g: string | null | undefined): number {
  if (!g) return 100;
  if (g === 'Kindergarten') return 0;
  const n = gradeNumbers(g);
  if (!n || !n.length) return 99;
  if (n.length === 1) return n[0];
  if (n.length === 2 && n[1] === n[0] + 1) return n[0] === 1 ? 2 : n[0];
  return 99;
}
/** null if OK, else a message. Teams without a grade are allowed (legacy data). */
const normGr = (g: string | null | undefined) => { try { return g ? normalizeGrade(g) : null; } catch { return g ?? null; } };
export function gradeMismatch(home: { name: string; grade: string | null }, away: { name: string; grade: string | null }, stated?: string | null): string | null {
  const hg = normGr(home.grade), ag = normGr(away.grade), sg = normGr(stated);
  if (hg && ag && hg !== ag) return `a game must be within one grade: ${home.name} is ${home.grade}, ${away.name} is ${away.grade}`;
  const g = hg || ag, gDisp = home.grade || away.grade;
  if (sg && g && sg !== g) return `grade "${stated}" doesn't match the teams (${gDisp})`;
  if (sg && (!hg || !ag) && [hg, ag].some((x) => x && x !== sg)) return `grade "${stated}" doesn't match the teams`;
  return null;
}

// ---- Season colors: one dark + one light for every team. Default home = light, away = dark; swap flips it.
export const sideOf = (swap: boolean, side: 'home' | 'away'): 'light' | 'dark' => ((side === 'home') !== !!swap ? 'light' : 'dark');
/** The team color and accent for a side: the side's season color, accented with the other one. */
export const sideColors = (season: { dark: string; light: string }, swap: boolean, side: 'home' | 'away') => {
  const wear = sideOf(swap, side);
  return { side: wear, color: season[wear], accent: season[wear === 'light' ? 'dark' : 'light'] };
};

// ---- Gender / division: Boys or Girls. A game must be within one grade AND one gender.
/** "boys"/"b"/"m"/"male" -> "Boys"; "girls"/"g"/"f"/"female" -> "Girls"; empty -> null; anything else throws (400). */
export function normalizeGender(v: unknown): 'Boys' | 'Girls' | null {
  const t = String(v ?? '').trim().toLowerCase(); if (!t) return null;
  if (['boys', 'boy', 'b', 'm', 'male', 'men'].includes(t)) return 'Boys';
  if (['girls', 'girl', 'g', 'f', 'female', 'women'].includes(t)) return 'Girls';
  throw Object.assign(new Error(`gender "${String(v).slice(0, 20)}" must be Boys or Girls (or empty)`), { status: 400 });
}
/** "3rd-4th Grade" + "Girls" -> "3rd-4th Grade Girls"; Kindergarten is mixed (always "Kindergarten"). */
export const divisionLabel = (grade: string | null | undefined, gender: string | null | undefined) =>
  grade === 'Kindergarten' ? 'Kindergarten' : [grade, gender].filter(Boolean).join(' ') || null;
/** Normalize a division string if it names a league grade (+ optional Boys/Girls), else keep custom text as-is. */
export function normalizeDivision(v: unknown): string | null {
  const t = String(v ?? '').trim(); if (!t) return null;
  const m = /^(.+?)\s+(boys?|girls?)$/i.exec(t);
  if (m) {
    try {
      const gr = normalizeGrade(m[1]);
      if (gr && (GRADES as readonly string[]).includes(gr)) return divisionLabel(gr, normalizeGender(m[2]));
    } catch {}
  }
  try {
    const gr = normalizeGrade(t);
    if (gr && (GRADES as readonly string[]).includes(gr)) return divisionLabel(gr, null);
  } catch {}
  return t;
}
/** null if OK, else a message. Teams without a gender are allowed (legacy data). */
export function genderMismatch(home: { name: string; gender?: string | null }, away: { name: string; gender?: string | null }, stated?: string | null): string | null {
  if (home.gender && away.gender && home.gender !== away.gender) return `a game must be within one gender: ${home.name} is ${home.gender}, ${away.name} is ${away.gender}`;
  const g = home.gender || away.gender;
  if (stated && g && stated !== g) return `gender "${stated}" doesn't match the teams (${g})`;
  return null;
}

// ---- League-local dates (America/Chicago by default) without a date library.
export const LEAGUE_TZ = process.env.TZ || 'America/Chicago';
/** YYYY-MM-DD of an instant in a time zone. */
export function localDate(ms: number, tz = LEAGUE_TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
/** Calendar math on YYYY-MM-DD strings (UTC noon, so DST never shifts the day). */
export const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
export const dowOf = (d: string) => new Date(d + 'T12:00:00Z').getUTCDay(); // 0 Sun .. 5 Fri, 6 Sat
/** "2026-10-17" -> "Saturday, Oct 17". */
export const dayLabel = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
/**
 * Demo weekend relative to today (league time): today if it's Friday, yesterday if it's Saturday,
 * otherwise the upcoming Friday. Returns { fri, sat }.
 */
export function demoWeekend(nowMs: number, tz = LEAGUE_TZ): { fri: string; sat: string } {
  const today = localDate(nowMs, tz), dow = dowOf(today);
  const fri = dow === 5 ? today : dow === 6 ? addDays(today, -1) : addDays(today, (5 - dow + 7) % 7);
  return { fri, sat: addDays(fri, 1) };
}
/** Lobby TV day: ?date=YYYY-MM-DD wins, then ?day=fri|sat (demo weekend), else today. */
export function resolveScheduleDay(q: { day?: string | null; date?: string | null }, nowMs: number, tz = LEAGUE_TZ): string {
  const d = String(q.date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T12:00:00Z')) && addDays(d, 0) === d) return d;
  const day = String(q.day || '').trim().toLowerCase();
  if (day === 'fri' || day === 'sat') return demoWeekend(nowMs, tz)[day];
  return localDate(nowMs, tz);
}

// ---- Schedule validation warnings (import + Admin). Warnings, not errors.
export const SPLIT_COURTS = ['west', 'east'];
/** West/East warning window (seasonConfig). Not the hard tip-off limit (GAME_TIP_WINDOW). */
export const SPLIT_START_MIN = seasonConfig.SPLIT_START_MIN, SPLIT_END_MIN = seasonConfig.SPLIT_END_MIN;
export type WarnGame = {
  id: number; date: string | null; startMin: number | null; durMin: number; court: string | null;
  grade: string | null; label: string | null; homeId: number; awayId: number; home: string; away: string;
  /** The cheer squad of the game's time slot (null = that slot has no cheer). */
  hasCheer: boolean; cheer?: string | null;
};
export type WarningCode = 'team-twice-weekend' | 'cheer-not-allowed' | 'split-outside-hours' | 'cheer-slot-empty' | 'cheer-slot-conflict';
/** gameId is null for slot-level warnings (cheer-slot-empty / cheer-slot-conflict); those carry `slot`. */
export type Warning = { gameId: number | null; code: WarningCode; message: string; slot?: { date: string; start: string }; candidates?: string[] };

// ---- Cheer by time slot (2026-10): one optional squad per scheduled 1-hour block, shared by West, East and Full.
/** "09:05" -> "09:00": a game belongs to the slot its start falls in (date + start floored to the hour). */
export function hourSlot(time: string): string {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(time ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`time "${time}" must be HH:MM (24h, league time)`);
  return `${m[1].padStart(2, '0')}:00`;
}
/** Slot start (minutes after midnight) of a game start. */
export const slotStartMin = (startMin: number) => Math.floor(startMin / 60) * 60;
export type CheerSlotInfo = { date: string; start: string; squad: string };
export type CheerConflict = { date: string; start: string; candidates: string[] };
/** Slot-level warnings: a cheer slot whose hour has no games, and legacy per-game data with 2+ squads in one slot. */
export function cheerSlotWarnings(slots: CheerSlotInfo[], games: Pick<WarnGame, 'date' | 'startMin'>[], conflicts: CheerConflict[]): Warning[] {
  const out: Warning[] = [];
  const busy = new Set(games.filter((g) => g.date && g.startMin != null).map((g) => `${g.date}|${hhmm(slotStartMin(g.startMin!))}`));
  for (const s of slots) {
    if (!busy.has(`${s.date}|${s.start}`)) out.push({ gameId: null, code: 'cheer-slot-empty', slot: { date: s.date, start: s.start }, message: `cheer slot ${dayLabel(s.date).split(',')[0].slice(0, 3)} ${s.date} ${s.start} (${s.squad}) has no games in that hour` });
  }
  for (const c of conflicts) {
    out.push({ gameId: null, code: 'cheer-slot-conflict', slot: { date: c.date, start: c.start }, candidates: c.candidates,
      message: `cheer slot ${c.date} ${c.start}: the old per-game data has ${c.candidates.length} squads (${c.candidates.join(', ')}); no slot was created, pick one in Admin` });
  }
  return out;
}
export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** Friday date of a Fri/Sat game (its weekend), else null. */
const weekendOf = (d: string) => (dowOf(d) === 5 ? d : dowOf(d) === 6 ? addDays(d, -1) : null);
export function scheduleWarnings(games: WarnGame[]): Warning[] {
  const out: Warning[] = [];
  const byTeam = new Map<string, WarnGame[]>();
  for (const g of games) {
    const wk = g.date ? weekendOf(g.date) : null;
    if (wk) for (const t of [g.homeId, g.awayId]) { const k = `${wk}|${t}`; byTeam.set(k, [...(byTeam.get(k) || []), g]); }
  }
  for (const [k, list] of byTeam) {
    if (list.length < 2) continue;
    const tid = Number(k.split('|')[1]);
    const name = list[0].homeId === tid ? list[0].home : list[0].away;
    const when = list.map((g) => `#${g.id} ${dayLabel(g.date!).split(',')[0].slice(0, 3)} ${g.startMin != null ? hhmm(g.startMin) : ''}`.trim()).join(', ');
    for (const g of list) out.push({ gameId: g.id, code: 'team-twice-weekend', message: `${g.label ? g.label + ' ' : ''}${name} plays ${list.length} times this weekend (${when})` });
  }
  for (const g of games) {
    const split = !!g.court && SPLIT_COURTS.includes(g.court);
    const inHours = g.startMin != null && g.startMin >= SPLIT_START_MIN && g.startMin + g.durMin <= SPLIT_END_MIN;
    if (split && g.startMin != null && !inHours) out.push({ gameId: g.id, code: 'split-outside-hours', message: `game #${g.id} on ${g.court} at ${hhmm(g.startMin)}–${hhmm(g.startMin + g.durMin)} is outside the split-court hours ${seasonConfig.SPLIT_START}–${seasonConfig.SPLIT_END}` });
    if (g.hasCheer) {
      const go = gradeOrder(g.grade);
      // Cheer is a time slot, not a court: Saturday, kindergarten through 6th, West, East or Full, inside the split window.
      const courtOk = g.court === 'full' || split;
      const why = !(go >= 0 && go <= 6) ? `cheer squads cover kindergarten through 6th grade (this is ${g.grade || 'no grade'})`
        : !(g.date && dowOf(g.date) === 6 && courtOk && inHours) ? `cheer squads are only on Saturday games (${seasonConfig.SPLIT_START}–${seasonConfig.SPLIT_END}, West/East/Full)` : null;
      const slot = g.startMin != null ? ` at ${hhmm(slotStartMin(g.startMin))}` : '';
      if (why) out.push({ gameId: g.id, code: 'cheer-not-allowed', message: `game #${g.id} (${g.home} vs ${g.away}) is in the cheer slot${slot}${g.cheer ? ' (' + g.cheer + ')' : ''}: ${why}` });
    }
  }
  return out.sort((a, b) => (a.gameId ?? 0) - (b.gameId ?? 0) || a.code.localeCompare(b.code));
}

// ---- Demo seed plan (pure, so tests can check the invariants without a database).
export type SeedGame = { date: string; time: string; court: 'full' | 'west' | 'east'; grade: string; gender: 'Boys' | 'Girls' | null; home: string; away: string; cheer?: string;
  /** Example data (2026-10): coach first names (season-long), locker rooms (per game), cheer squad coach + slot locker. */
  homeCoach: string; awayCoach: string; homeLocker: string; awayLocker: string; cheerCoach?: string; cheerLocker?: string };
/** Example first names (one coach per team for the season; pages show "Coach <name>"). */
export const DEMO_COACHES = ['Mike', 'Sarah', 'David', 'Rachel', 'Chris', 'Amy', 'Josh', 'Laura', 'Ben', 'Katie', 'Matt', 'Emily',
  'Tyler', 'Megan', 'Ryan', 'Hannah', 'Jason', 'Kristen', 'Brian', 'Lisa', 'Kevin', 'Jessica', 'Andy', 'Nicole', 'Steve', 'Heather', 'Mark',
  'Amanda', 'Dan', 'Melissa', 'Greg', 'Jenny', 'Scott', 'Erin', 'Tim', 'Julie', 'Nate', 'Carrie', 'Luke', 'Beth', 'Adam', 'Kara', 'Eric',
  'Dana', 'Jeff', 'Molly', 'Paul', 'Tara'];
/** Example locker rooms (they change every week): CH (church hall) and rooms 1-6. */
export const DEMO_ROOMS = ['CH', '1', '2', '3', '4', '5', '6'];
/** Deterministic rotation for a slot (date + HH:00): the same slot always starts at the same room. */
export function slotSeed(date: string, start: string): number {
  const d = Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);
  return d * 3 + Number(start.slice(0, 2));
}
/**
 * `need` locker rooms for one slot, none of them in `taken` (rooms already used in that slot), in a rotation
 * that starts at `seed`. If the slot needs more rooms than are free, the extra ones repeat (never happens in the demo).
 */
export function slotRooms(taken: (string | null | undefined)[], need: number, seed: number, rooms = DEMO_ROOMS): string[] {
  const used = new Set(taken.filter((x): x is string => !!x)), out: string[] = [];
  for (let i = 0; i < rooms.length && out.length < need; i++) { const r = rooms[(seed + i) % rooms.length]; if (!used.has(r)) { used.add(r); out.push(r); } }
  while (out.length < need) out.push(rooms[(seed + out.length) % rooms.length]);
  return out;
}
export const BOYS = ['Eagles', 'Lions', 'Bears', 'Hawks', 'Tigers', 'Rams', 'Knights', 'Warriors', 'Panthers', 'Falcons', 'Wildcats', 'Mustangs'];
export const GIRLS = ['Lady Stars', 'Lady Comets', 'Lady Lightning', 'Lady Sparks', 'Lady Hornets', 'Lady Cardinals', 'Lady Blaze', 'Lady Jaguars', 'Lady Storm', 'Lady Thunder', 'Lady Doves', 'Lady Bluebirds'];
/**
 * The demo weekend: Friday Full Court 17:30/18:30/19:30; Saturday West + East hourly 08:00–15:00 (16 games:
 * Kindergarten 08:00 mixed, 1st-2nd Grade 09:00–10:00, 3rd-4th Grade 11:00–15:00), then Full Court 16:30/17:30/18:30 (5th-6th Grade).
 * Numbered grade slots have one Boys and one Girls game (West Boys/East Girls, swapped every other slot); Kindergarten is mixed (gender null).
 * Every team plays exactly once (2 teams per game, names unique per grade + gender). One cheer squad on a few Saturday split games.
 */
export function demoSeedPlan(w: { fri: string; sat: string }): SeedGame[] {
  const used = new Map<string, number>();
  const pair = (grade: string, gender: 'Boys' | 'Girls' | null) => {
    const k = `${grade}|${gender ?? ''}`, i = used.get(k) ?? 0, pool = gender === 'Girls' ? GIRLS : BOYS;
    used.set(k, i + 2); return [pool[i], pool[i + 1]] as const;
  };
  const games: SeedGame[] = [];
  const add = (date: string, time: string, court: SeedGame['court'], grade: string, gender: 'Boys' | 'Girls' | null, cheer?: string) => {
    const [home, away] = pair(grade, gender);
    const i = games.length, C = DEMO_COACHES;
    games.push({ date, time, court, grade, gender, home, away, homeCoach: C[(2 * i) % C.length], awayCoach: C[(2 * i + 1) % C.length],
      homeLocker: '', awayLocker: '', ...(cheer ? { cheer } : {}) });
  };
  // Friday night: Full Court, 5th-6th Grade.
  add(w.fri, '17:30', 'full', '5th-6th Grade', 'Boys'); add(w.fri, '18:30', 'full', '5th-6th Grade', 'Girls'); add(w.fri, '19:30', 'full', '5th-6th Grade', 'Boys');
  // Saturday split block: Kindergarten at 08:00 (mixed), 1st-2nd Grade at 09:00–10:00, 3rd-4th Grade at 11:00–15:00.
  const gradeAt = (h: number) => (h === 8 ? 'Kindergarten' : h <= 10 ? '1st-2nd Grade' : '3rd-4th Grade');
  const cheers: Record<string, string> = { '09:00 west': 'Lenexa Lil Cheer', '11:00 east': 'LBC Sparkle Squad', '12:00 west': 'Joyful Noise Cheer', '14:00 east': 'LBC Spirit Cheer' };
  for (let h = 8; h <= 15; h++) {
    const t = `${String(h).padStart(2, '0')}:00`, gr = gradeAt(h), boysWest = h % 2 === 0;
    add(w.sat, t, 'west', gr, gr === 'Kindergarten' ? null : (boysWest ? 'Boys' : 'Girls'), cheers[`${t} west`]);
    add(w.sat, t, 'east', gr, gr === 'Kindergarten' ? null : (boysWest ? 'Girls' : 'Boys'), cheers[`${t} east`]);
  }
  add(w.sat, '16:30', 'full', '5th-6th Grade', 'Girls'); add(w.sat, '17:30', 'full', '5th-6th Grade', 'Boys'); add(w.sat, '18:30', 'full', '5th-6th Grade', 'Girls');
  // Cheer squad coaches: the names after the team coaches, so every coach name in the demo is different.
  let k = 0;
  for (const g of games) if (g.cheer) { g.cheerCoach = DEMO_COACHES[(2 * games.length + k) % DEMO_COACHES.length]; k++; }
  // Locker rooms per slot (date + hour, all courts): the cheer squad first, then home/away of each game; no room twice.
  const bySlot = new Map<string, SeedGame[]>();
  for (const g of games) { const key = `${g.date} ${hourSlot(g.time)}`; bySlot.set(key, [...(bySlot.get(key) || []), g]); }
  for (const [key, list] of bySlot) {
    const [date, start] = key.split(' '), cheer = list.find((g) => g.cheer);
    const rooms = slotRooms([], list.length * 2 + (cheer ? 1 : 0), slotSeed(date, start));
    if (cheer) { const c = rooms.shift()!; for (const g of list) if (g.cheer) g.cheerLocker = c; }
    for (const g of list) { g.homeLocker = rooms.shift()!; g.awayLocker = rooms.shift()!; }
  }
  return games;
}

/**
 * Game-day tip-off window (league-local), used by reschedule and by a plain edit that changes the time.
 * No per-day game hours are configured anywhere else (a West/East game outside the seasonConfig split window is
 * only a warning), so this is the DEFAULT for Aaron to confirm: first tip 08:00, last tip 21:00 (inclusive), Friday and Saturday only.
 */
export const GAME_DAYS = [5, 6] as const; // Fri, Sat
export const GAME_TIP_WINDOW = { first: '08:00', last: '21:00' } as const;
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Calendar-valid YYYY-MM-DD (2026-02-30 -> false). */
export const isIsoDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T12:00:00Z')) && new Date(d + 'T12:00:00Z').toISOString().slice(0, 10) === d;
/** Hard errors for a game at league-local date + HH:MM: Fri/Sat only, tip-off inside GAME_TIP_WINDOW. */
export function gameTimeErrors(date: string, hm: string): string[] {
  const out: string[] = [];
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (!(GAME_DAYS as readonly number[]).includes(dow)) out.push(`Games can only be on Friday or Saturday (${DOW_NAMES[dow]} ${date} is not).`);
  if (hm < GAME_TIP_WINDOW.first || hm > GAME_TIP_WINDOW.last) out.push(`Tip-off ${hm} is outside game hours (${GAME_TIP_WINDOW.first}–${GAME_TIP_WINDOW.last} league time).`);
  return out;
}
