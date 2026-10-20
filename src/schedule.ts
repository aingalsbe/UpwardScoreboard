// Shared-floor scheduling rules. One gym floor: Full, or West + East at the same time.
// A court lists the courts it can't run alongside (courts.conflicts_with, slugs); the rule is
// symmetric, so Full -> [west, east] is enough. West and East don't list each other, so they may overlap.

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
const ORD = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
/** "5", "5th", "5th grade", "Grade 5" -> "5th Grade"; "K"/"Kindergarten" -> "Kindergarten"; empty -> null; else trimmed text as-is. */
export function normalizeGrade(v: unknown): string | null {
  const t = String(v ?? '').trim(); if (!t) return null;
  if (/^(k|kg|kinder|kindergarten)$/i.test(t)) return 'Kindergarten';
  const m = /^(?:grade\s*)?(\d{1,2})(?:st|nd|rd|th)?(?:\s*grade)?$/i.exec(t);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `${ORD(Number(m[1]))} Grade`;
  if (t.length > 30) throw Object.assign(new Error(`grade "${t.slice(0, 20)}…" is longer than 30 characters`), { status: 400 });
  return t;
}
/** Sort key: Kindergarten 0, "Nth Grade" N, other labels 99, none 100. */
export function gradeOrder(g: string | null | undefined): number {
  if (!g) return 100;
  if (g === 'Kindergarten') return 0;
  const m = /^(\d{1,2})(st|nd|rd|th) Grade$/.exec(g); return m ? Number(m[1]) : 99;
}
/** null if OK, else a message. Teams without a grade are allowed (legacy data). */
export function gradeMismatch(home: { name: string; grade: string | null }, away: { name: string; grade: string | null }, stated?: string | null): string | null {
  if (home.grade && away.grade && home.grade !== away.grade) return `a game must be within one grade: ${home.name} is ${home.grade}, ${away.name} is ${away.grade}`;
  const g = home.grade || away.grade;
  if (stated && g && stated !== g) return `grade "${stated}" doesn't match the teams (${g})`;
  if (stated && (!home.grade || !away.grade) && [home, away].some((t) => t.grade && t.grade !== stated)) return `grade "${stated}" doesn't match the teams`;
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
/** "3rd Grade" + "Girls" -> "3rd Grade Girls". */
export const divisionLabel = (grade: string | null | undefined, gender: string | null | undefined) => [grade, gender].filter(Boolean).join(' ') || null;
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
export const SPLIT_START_MIN = 8 * 60, SPLIT_END_MIN = 16 * 60;
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
    if (split && g.startMin != null && !inHours) out.push({ gameId: g.id, code: 'split-outside-hours', message: `game #${g.id} on ${g.court} at ${hhmm(g.startMin)}–${hhmm(g.startMin + g.durMin)} is outside the split-court hours 08:00–16:00` });
    if (g.hasCheer) {
      const go = gradeOrder(g.grade);
      const why = !(go >= 2 && go <= 4) ? `cheer squads are for 2nd–4th grade (this is ${g.grade || 'no grade'})`
        : !(g.date && dowOf(g.date) === 6 && split && inHours) ? 'cheer squads are only on Saturday split-court games (West/East, 08:00–16:00)' : null;
      const slot = g.startMin != null ? ` at ${hhmm(slotStartMin(g.startMin))}` : '';
      if (why) out.push({ gameId: g.id, code: 'cheer-not-allowed', message: `game #${g.id} (${g.home} vs ${g.away}) is in the cheer slot${slot}${g.cheer ? ' (' + g.cheer + ')' : ''}: ${why}` });
    }
  }
  return out.sort((a, b) => (a.gameId ?? 0) - (b.gameId ?? 0) || a.code.localeCompare(b.code));
}

// ---- Demo seed plan (pure, so tests can check the invariants without a database).
export type SeedGame = { date: string; time: string; court: 'full' | 'west' | 'east'; grade: string; gender: 'Boys' | 'Girls'; home: string; away: string; cheer?: string;
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
const BOYS = ['Eagles', 'Lions', 'Bears', 'Hawks', 'Tigers', 'Rams', 'Knights', 'Warriors', 'Panthers', 'Falcons', 'Wildcats', 'Mustangs'];
const GIRLS = ['Stars', 'Comets', 'Lightning', 'Sparks', 'Hornets', 'Cardinals', 'Blaze', 'Jaguars', 'Storm', 'Thunder', 'Doves', 'Bluebirds'];
/**
 * The demo weekend: Friday Full Court 17:30/18:30/19:30; Saturday West + East hourly 08:00–15:00 (16 games,
 * 2nd grade 08–10, 3rd 11–13, 4th 14–15), then Full Court 16:30/17:30/18:30. Full Court = grades 5–6.
 * Each slot has one Boys and one Girls game (West Boys/East Girls, swapped every other slot). Every team plays
 * exactly once (2 teams per game, names unique per grade + gender). One cheer squad on a few Saturday split games.
 */
export function demoSeedPlan(w: { fri: string; sat: string }): SeedGame[] {
  const used = new Map<string, number>();
  const pair = (grade: string, gender: 'Boys' | 'Girls') => {
    const k = `${grade}|${gender}`, i = used.get(k) ?? 0, pool = gender === 'Boys' ? BOYS : GIRLS;
    used.set(k, i + 2); return [pool[i], pool[i + 1]] as const;
  };
  const games: SeedGame[] = [];
  const add = (date: string, time: string, court: SeedGame['court'], grade: string, gender: 'Boys' | 'Girls', cheer?: string) => {
    const [home, away] = pair(grade, gender);
    const i = games.length, C = DEMO_COACHES;
    games.push({ date, time, court, grade, gender, home, away, homeCoach: C[(2 * i) % C.length], awayCoach: C[(2 * i + 1) % C.length],
      homeLocker: '', awayLocker: '', ...(cheer ? { cheer } : {}) });
  };
  // Friday night: Full Court, grades 5–6.
  add(w.fri, '17:30', 'full', '5th Grade', 'Boys'); add(w.fri, '18:30', 'full', '5th Grade', 'Girls'); add(w.fri, '19:30', 'full', '6th Grade', 'Boys');
  // Saturday split block.
  const gradeAt = (h: number) => (h <= 10 ? '2nd Grade' : h <= 13 ? '3rd Grade' : '4th Grade');
  // One cheer squad per game (not per side), on a few Saturday split games, 2nd–4th grade.
  const cheers: Record<string, string> = { '09:00 west': 'Lenexa Lil Cheer', '11:00 east': 'LBC Sparkle Squad', '12:00 west': 'Joyful Noise Cheer', '14:00 east': 'LBC Spirit Cheer' };
  for (let h = 8; h <= 15; h++) {
    const t = `${String(h).padStart(2, '0')}:00`, boysWest = h % 2 === 0;
    add(w.sat, t, 'west', gradeAt(h), boysWest ? 'Boys' : 'Girls', cheers[`${t} west`]);
    add(w.sat, t, 'east', gradeAt(h), boysWest ? 'Girls' : 'Boys', cheers[`${t} east`]);
  }
  add(w.sat, '16:30', 'full', '6th Grade', 'Girls'); add(w.sat, '17:30', 'full', '6th Grade', 'Boys'); add(w.sat, '18:30', 'full', '5th Grade', 'Girls');
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
