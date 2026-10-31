// Pure 2027 season CSV parsing. No database. Reads the four Jessica CSVs, normalizes
// text and courts, and collapses dated practice rows into one weekly slot per team/squad.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvTable } from './csv.js';
import { seasonConfig } from './season-config.js';
import { BOYS, GIRLS, addDays, divisionLabel, dowOf, gradeOrder, hourSlot, normalizeDivision } from './schedule.js';

export const SEASON_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/season-2027');

export class SeasonImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeasonImportError';
  }
}

/** Trim and collapse internal whitespace. "Erin  Friesen" -> "Erin Friesen"; "Room 22 " -> "Room 22". */
export function normalizeSpaces(s: unknown): string {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

/** Blank coaches (and the literal "nan") become null. A typed "Coach " prefix is dropped. */
export function normalizePerson(s: unknown): string | null {
  const t = normalizeSpaces(s).replace(/^coach\s+/i, '').trim();
  if (!t || t.toLowerCase() === 'nan') return null;
  return t;
}

/**
 * Division text: trim, collapse spaces, and close spaces around a hyphen
 * ("1st - 2nd Grade Girls" -> "1st-2nd Grade Girls"). League divisions then go
 * through normalizeDivision so the stored label matches the rest of the app.
 */
export function normalizeDivisionName(s: unknown): string {
  const t = normalizeSpaces(s).replace(/\s*-\s*/g, '-');
  if (!t) throw new SeasonImportError('division is blank');
  try {
    return normalizeDivision(t) ?? t;
  } catch (e) {
    throw new SeasonImportError(e instanceof Error ? e.message : String(e));
  }
}

/** "1/15/2027" -> "2027-01-15" (calendar-validated, no timezone). */
export function parseUsDate(s: unknown): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(normalizeSpaces(s));
  if (!m) throw new SeasonImportError(`date "${s}" must be M/D/YYYY`);
  const y = Number(m[3]), mo = Number(m[1]), d = Number(m[2]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new SeasonImportError(`date "${s}" is not a real calendar day`);
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "5:15 PM" / "8:00 AM" -> "17:15" / "08:00". */
export function parseAmpm(s: unknown): string {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(normalizeSpaces(s));
  if (!m) throw new SeasonImportError(`time "${s}" must be H:MM AM/PM`);
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 1 || h > 12 || min > 59) throw new SeasonImportError(`time "${s}" is not a real time`);
  const ap = m[3].toUpperCase();
  if (ap === 'AM') { if (h === 12) h = 0; }
  else if (h !== 12) h += 12;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function addMinutes(hm: string, mins: number): string {
  const [h, m] = hm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

const courtKey = (s: unknown) => normalizeSpaces(s).toLowerCase();

export function mapGameCourt(facility: unknown): 'west' | 'east' | 'full' {
  const v = seasonConfig.GAME_COURT[courtKey(facility)];
  if (!v) throw new SeasonImportError(`unknown game court "${facility}"`);
  return v;
}

export function mapPracticeCourt(facility: unknown): 'west1' | 'west2' | 'east1' | 'east2' {
  const v = seasonConfig.PRACTICE_COURT[courtKey(facility)];
  if (!v) throw new SeasonImportError(`unknown practice court "${facility}"`);
  return v;
}

/** Kindergarten stays mixed (gender null). Other league divisions split into grade + Boys/Girls. */
export function splitDivision(division: string): { grade: string; gender: 'Boys' | 'Girls' | null } {
  if (division === 'Kindergarten') return { grade: 'Kindergarten', gender: null };
  const m = /^(.+) (Boys|Girls)$/.exec(division);
  if (!m) throw new SeasonImportError(`unrecognized division "${division}"`);
  return { grade: m[1], gender: m[2] as 'Boys' | 'Girls' };
}

export const teamKey = (division: string, name: string) => `${division}|${name}`;

export interface SeasonTeam {
  name: string;
  coach: string | null;
  division: string;
  grade: string;
  gender: 'Boys' | 'Girls' | null;
  gradeOrder: number;
}

export interface SeasonGame {
  date: string;
  time: string;
  court: 'west' | 'east' | 'full';
  division: string;
  grade: string;
  gender: 'Boys' | 'Girls' | null;
  home: string;
  away: string;
}

export interface SeasonCheerSquad { name: string; coach: string | null; division: string }
export interface SeasonCheerSlot { date: string; time: string; hour: string; squad: string; division: string }

export interface WeeklyBasketballSlot {
  day: number;
  start: string;
  court: 'west1' | 'west2' | 'east1' | 'east2';
  team: string;
  division: string;
}
export interface WeeklyCheerPractice {
  day: number;
  room: string;
  squad: string;
  division: string;
  /** Actual CSV start (not stored). 18:00 for everyone except Spirit Squad. */
  start: string;
  end: string;
}

export interface DivisionCount { division: string; teams: number; games: number }

export interface SeasonPlan {
  teams: SeasonTeam[];
  games: SeasonGame[];
  divisions: DivisionCount[];
  gamesByCourt: { west: number; east: number; full: number };
  fridayLate: number;
  cheerSquads: SeasonCheerSquad[];
  cheerSlots: SeasonCheerSlot[];
  practiceDays: { day: number; start: string; end: string }[];
  basketballSlots: WeeklyBasketballSlot[];
  basketballByDay: Record<number, number>;
  basketballDatedRows: number;
  cheerPracticeSlots: WeeklyCheerPractice[];
  cheerPracticeByDay: Record<number, number>;
  cheerPracticeDatedRows: number;
  warnings: string[];
}

export interface SeasonCsvs {
  games: string;
  basketballPractice: string;
  cheerGames: string;
  cheerPractice: string;
}

export interface SeasonFiles {
  games: string;
  basketballPractice: string;
  cheerGames: string;
  cheerPractice: string;
}

export function defaultSeasonFiles(dir = SEASON_DATA_DIR): SeasonFiles {
  return {
    games: path.join(dir, 'Upward Game Schedule 2027.csv'),
    basketballPractice: path.join(dir, 'Upward Basketball Practice Schedule 2027.csv'),
    cheerGames: path.join(dir, 'Cheer Game Schedule.csv'),
    cheerPractice: path.join(dir, 'Cheer Practice Schedule.csv'),
  };
}

export function readSeasonCsvs(files: SeasonFiles = defaultSeasonFiles()): SeasonCsvs {
  const read = (p: string) => {
    if (!fs.existsSync(p)) throw new SeasonImportError(`season file not found: ${p}`);
    return fs.readFileSync(p, 'utf8');
  };
  return {
    games: read(files.games),
    basketballPractice: read(files.basketballPractice),
    cheerGames: read(files.cheerGames),
    cheerPractice: read(files.cheerPractice),
  };
}

const DAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];

function requireHeaders(headers: string[], need: string[], file: string) {
  for (const h of need) if (!headers.includes(h)) throw new SeasonImportError(`${file} is missing column ${h}`);
}

function cell(row: Record<string, string>, key: string): string {
  return row[key] ?? '';
}

interface CoachMap { set(key: string, coach: string | null, source: string): void; get(key: string): string | null }

function coachMap(): CoachMap {
  const m = new Map<string, string | null>();
  return {
    set(key, coach, source) {
      if (!m.has(key)) { m.set(key, coach); return; }
      const prev = m.get(key) ?? null;
      if (coach == null) return;
      if (prev == null) { m.set(key, coach); return; }
      if (prev !== coach) throw new SeasonImportError(`${key} has two coaches: "${prev}" (${source}) and "${coach}"`);
    },
    get(key) { return m.has(key) ? (m.get(key) ?? null) : null; },
  };
}

function practiceDow(iso: string): number {
  const dow = dowOf(iso); // 0 Sun .. 6 Sat
  const day = dow === 0 ? 7 : dow; // Mon=1 .. Sun=7
  if (day < 1 || day > 4) throw new SeasonImportError(`practice date ${iso} is not Monday–Thursday`);
  return day;
}

function shortClock(hm: string): string {
  const [h, m] = hm.split(':').map(Number);
  return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function buildSeasonPlan(csvs: SeasonCsvs): SeasonPlan {
  const gamesTable = parseCsvTable(csvs.games);
  requireHeaders(gamesTable.headers, ['date', 'divisionname', 'hometeam', 'awayteam', 'starttime', 'endtime', 'facilityname', 'hometeamheadcoachname', 'awayteamheadcoachname'], 'game schedule');
  const ballTable = parseCsvTable(csvs.basketballPractice);
  requireHeaders(ballTable.headers, ['divisionname', 'teamname', 'headcoach', 'date', 'starttime', 'endtime', 'facilityname'], 'basketball practice');
  const cheerTable = parseCsvTable(csvs.cheerGames);
  requireHeaders(cheerTable.headers, ['date', 'divisionname', 'teamname', 'starttime', 'endtime', 'hometeamheadcoachname'], 'cheer game schedule');
  const cheerPrTable = parseCsvTable(csvs.cheerPractice);
  requireHeaders(cheerPrTable.headers, ['divisionname', 'teamname', 'headcoach', 'date', 'starttime', 'endtime', 'facilityname'], 'cheer practice');

  const coaches = coachMap();
  const games: SeasonGame[] = [];
  const seenGame = new Set<string>();
  for (let i = 0; i < gamesTable.rows.length; i++) {
    const r = gamesTable.rows[i], line = i + 2;
    try {
      const division = normalizeDivisionName(cell(r, 'divisionname'));
      const { grade, gender } = splitDivision(division);
      const home = normalizeSpaces(cell(r, 'hometeam'));
      const away = normalizeSpaces(cell(r, 'awayteam'));
      if (!home || !away) throw new SeasonImportError('home and away are required');
      if (home === away) throw new SeasonImportError(`${home} is both home and away`);
      const date = parseUsDate(cell(r, 'date'));
      const time = parseAmpm(cell(r, 'starttime'));
      const end = parseAmpm(cell(r, 'endtime'));
      if (addMinutes(time, seasonConfig.GAME_MINUTES) !== end) throw new SeasonImportError(`${time}–${end} is not ${seasonConfig.GAME_MINUTES} minutes`);
      const court = mapGameCourt(cell(r, 'facilityname'));
      const key = `${date}|${time}|${court}|${home}|${away}`;
      if (seenGame.has(key)) throw new SeasonImportError(`duplicate game ${key}`);
      seenGame.add(key);
      coaches.set(teamKey(division, home), normalizePerson(cell(r, 'hometeamheadcoachname')), `game row ${line}`);
      coaches.set(teamKey(division, away), normalizePerson(cell(r, 'awayteamheadcoachname')), `game row ${line}`);
      games.push({ date, time, court, division, grade, gender, home, away });
    } catch (e) {
      if (e instanceof SeasonImportError && !e.message.startsWith('game row')) throw new SeasonImportError(`game row ${line}: ${e.message}`);
      throw e;
    }
  }

  type BallDated = { division: string; team: string; date: string; day: number; start: string; court: WeeklyBasketballSlot['court'] };
  const ballDated: BallDated[] = [];
  for (let i = 0; i < ballTable.rows.length; i++) {
    const r = ballTable.rows[i], line = i + 2;
    try {
      const division = normalizeDivisionName(cell(r, 'divisionname'));
      const team = normalizeSpaces(cell(r, 'teamname'));
      if (!team) throw new SeasonImportError('team name is required');
      const date = parseUsDate(cell(r, 'date'));
      const start = parseAmpm(cell(r, 'starttime'));
      const end = parseAmpm(cell(r, 'endtime'));
      if (addMinutes(start, 60) !== end) throw new SeasonImportError(`${start}–${end} is not 60 minutes`);
      const court = mapPracticeCourt(cell(r, 'facilityname'));
      coaches.set(teamKey(division, team), normalizePerson(cell(r, 'headcoach')), `basketball practice row ${line}`);
      ballDated.push({ division, team, date, day: practiceDow(date), start, court });
    } catch (e) {
      if (e instanceof SeasonImportError && !/^basketball practice row/.test(e.message)) throw new SeasonImportError(`basketball practice row ${line}: ${e.message}`);
      throw e;
    }
  }

  const cheerSquadCoach = coachMap();
  const cheerSlots: SeasonCheerSlot[] = [];
  const slotKey = new Set<string>();
  for (let i = 0; i < cheerTable.rows.length; i++) {
    const r = cheerTable.rows[i], line = i + 2;
    try {
      const division = normalizeDivisionName(cell(r, 'divisionname'));
      const squad = normalizeSpaces(cell(r, 'teamname'));
      if (!squad) throw new SeasonImportError('squad name is required');
      const date = parseUsDate(cell(r, 'date'));
      const time = parseAmpm(cell(r, 'starttime'));
      const end = parseAmpm(cell(r, 'endtime'));
      if (addMinutes(time, 60) !== end) throw new SeasonImportError(`${time}–${end} is not 60 minutes`);
      const hour = hourSlot(time);
      const key = `${date}|${hour}`;
      if (slotKey.has(key)) throw new SeasonImportError(`two cheer squads in ${date} ${hour}`);
      slotKey.add(key);
      // FacilityName is ignored: cheer is a time slot, not a court.
      cheerSquadCoach.set(squad, normalizePerson(cell(r, 'hometeamheadcoachname')), `cheer game row ${line}`);
      cheerSlots.push({ date, time, hour, squad, division });
    } catch (e) {
      if (e instanceof SeasonImportError && !/^cheer game row/.test(e.message)) throw new SeasonImportError(`cheer game row ${line}: ${e.message}`);
      throw e;
    }
  }

  type CheerDated = { division: string; squad: string; date: string; day: number; start: string; end: string; room: string };
  const cheerDated: CheerDated[] = [];
  for (let i = 0; i < cheerPrTable.rows.length; i++) {
    const r = cheerPrTable.rows[i], line = i + 2;
    try {
      const division = normalizeDivisionName(cell(r, 'divisionname'));
      const squad = normalizeSpaces(cell(r, 'teamname'));
      if (!squad) throw new SeasonImportError('squad name is required');
      const date = parseUsDate(cell(r, 'date'));
      const start = parseAmpm(cell(r, 'starttime'));
      const end = parseAmpm(cell(r, 'endtime'));
      if (addMinutes(start, 60) !== end) throw new SeasonImportError(`${start}–${end} is not 60 minutes`);
      const room = normalizeSpaces(cell(r, 'facilityname'));
      if (!room || room.length > 40) throw new SeasonImportError(`room "${room}" must be 1–40 characters`);
      cheerSquadCoach.set(squad, normalizePerson(cell(r, 'headcoach')), `cheer practice row ${line}`);
      cheerDated.push({ division, squad, date, day: practiceDow(date), start, end, room });
    } catch (e) {
      if (e instanceof SeasonImportError && !/^cheer practice row/.test(e.message)) throw new SeasonImportError(`cheer practice row ${line}: ${e.message}`);
      throw e;
    }
  }

  const ballByTeam = new Map<string, BallDated[]>();
  for (const row of ballDated) {
    const k = teamKey(row.division, row.team);
    ballByTeam.set(k, [...(ballByTeam.get(k) || []), row]);
  }
  const basketballSlots: WeeklyBasketballSlot[] = [];
  for (const [k, rows] of ballByTeam) {
    const sigs = [...new Set(rows.map((r) => `${r.day}|${r.start}|${r.court}`))];
    if (sigs.length !== 1) throw new SeasonImportError(`${k} has more than one weekly practice slot: ${sigs.join('; ')}`);
    const [day, start, court] = sigs[0].split('|');
    basketballSlots.push({ day: Number(day), start, court: court as WeeklyBasketballSlot['court'], team: rows[0].team, division: rows[0].division });
  }

  const gameTeams = new Map<string, { division: string; name: string }>();
  for (const g of games) {
    gameTeams.set(teamKey(g.division, g.home), { division: g.division, name: g.home });
    gameTeams.set(teamKey(g.division, g.away), { division: g.division, name: g.away });
  }
  for (const k of gameTeams.keys()) if (!ballByTeam.has(k)) throw new SeasonImportError(`${k} has games but no basketball practice slot`);
  for (const k of ballByTeam.keys()) if (!gameTeams.has(k)) throw new SeasonImportError(`${k} has a practice slot but no games`);

  const teams: SeasonTeam[] = [...gameTeams.values()].map((t) => {
    const { grade, gender } = splitDivision(t.division);
    const label = divisionLabel(grade, gender);
    if (label !== t.division) throw new SeasonImportError(`division "${t.division}" does not match stored label "${label}"`);
    return { name: t.name, coach: coaches.get(teamKey(t.division, t.name)), division: t.division, grade, gender, gradeOrder: gradeOrder(grade) };
  }).sort((a, b) => a.gradeOrder - b.gradeOrder || (a.gender || '').localeCompare(b.gender || '') || a.name.localeCompare(b.name));

  const squadDiv = new Map<string, string>();
  for (const s of cheerSlots) {
    const prev = squadDiv.get(s.squad);
    if (prev && prev !== s.division) throw new SeasonImportError(`${s.squad} is in both ${prev} and ${s.division}`);
    squadDiv.set(s.squad, s.division);
  }
  const cheerBySquad = new Map<string, CheerDated[]>();
  for (const row of cheerDated) cheerBySquad.set(row.squad, [...(cheerBySquad.get(row.squad) || []), row]);
  const warnings: string[] = [];
  const cheerPracticeSlots: WeeklyCheerPractice[] = [];
  for (const [squad, rows] of cheerBySquad) {
    const sigs = [...new Set(rows.map((r) => `${r.day}|${r.room}`))];
    if (sigs.length !== 1) throw new SeasonImportError(`${squad} has more than one weekly cheer practice: ${sigs.join('; ')}`);
    const times = [...new Set(rows.map((r) => `${r.start}|${r.end}`))];
    if (times.length !== 1) throw new SeasonImportError(`${squad} practice time changes across weeks: ${times.join('; ')}`);
    const [day, room] = sigs[0].split('|');
    const [start, end] = times[0].split('|');
    const division = rows[0].division;
    const fromGames = squadDiv.get(squad);
    if (fromGames && fromGames !== division) throw new SeasonImportError(`${squad} practice division ${division} does not match cheer games (${fromGames})`);
    if (!fromGames) squadDiv.set(squad, division);
    if (start !== '18:00' || end !== '19:00') {
      warnings.push(`${squad} practices ${shortClock(start)}–${shortClock(end)} on ${DAY[Number(day)]} (${room}). Cheer practice slots have no start time, and practice_days has one range per day (Monday 18:00–19:00 is the hour everyone else uses, inside the stored 17:00–21:00 day). The ${shortClock(start).replace(' PM', '').replace(' AM', '')} start is not stored.`);
    }
    cheerPracticeSlots.push({ day: Number(day), room, squad, division, start, end });
  }
  for (const squad of squadDiv.keys()) if (!cheerBySquad.has(squad)) throw new SeasonImportError(`${squad} has cheer games but no cheer practice slot`);

  const cheerSquads: SeasonCheerSquad[] = [...squadDiv.entries()].map(([name, division]) => ({
    name, division, coach: cheerSquadCoach.get(name),
  })).sort((a, b) => a.division.localeCompare(b.division) || a.name.localeCompare(b.name));

  const divOrder = (d: string) => {
    const { grade, gender } = splitDivision(d);
    return gradeOrder(grade) * 10 + (gender === 'Girls' ? 1 : 0);
  };
  const divisionNames = [...new Set(teams.map((t) => t.division))].sort((a, b) => divOrder(a) - divOrder(b) || a.localeCompare(b));
  const divisions: DivisionCount[] = divisionNames.map((division) => ({
    division,
    teams: teams.filter((t) => t.division === division).length,
    games: games.filter((g) => g.division === division).length,
  }));
  const gamesByCourt = {
    west: games.filter((g) => g.court === 'west').length,
    east: games.filter((g) => g.court === 'east').length,
    full: games.filter((g) => g.court === 'full').length,
  };
  const basketballByDay: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const s of basketballSlots) basketballByDay[s.day] = (basketballByDay[s.day] || 0) + 1;
  const cheerPracticeByDay: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const s of cheerPracticeSlots) cheerPracticeByDay[s.day] = (cheerPracticeByDay[s.day] || 0) + 1;

  return {
    teams, games, divisions, gamesByCourt,
    fridayLate: games.filter((g) => dowOf(g.date) === 5 && g.time === '20:15').length,
    cheerSquads, cheerSlots,
    practiceDays: seasonConfig.PRACTICE_DAYS.map((d) => ({ ...d })),
    basketballSlots, basketballByDay, basketballDatedRows: ballDated.length,
    cheerPracticeSlots, cheerPracticeByDay, cheerPracticeDatedRows: cheerDated.length,
    warnings,
  };
}

const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu'];

export function formatSeasonReport(plan: SeasonPlan): string {
  const lines = ['2027 season import', 'Division | Teams | Games'];
  for (const d of plan.divisions) lines.push(`${d.division}: ${d.teams} teams, ${d.games} games`);
  lines.push(`Total: ${plan.teams.length} teams, ${plan.games.length} games`);
  lines.push(`Games by court: west ${plan.gamesByCourt.west}, east ${plan.gamesByCourt.east}, full ${plan.gamesByCourt.full}`);
  lines.push(`Friday 8:15 PM games: ${plan.fridayLate}`);
  lines.push(`Practice slots by day: ${[1, 2, 3, 4].map((d) => `${DAY_SHORT[d]} ${plan.basketballByDay[d] || 0}`).join(', ')} (${plan.basketballSlots.length} weekly, ${plan.basketballDatedRows} dated rows)`);
  const squadByDiv = new Map<string, number>();
  for (const s of plan.cheerSquads) squadByDiv.set(s.division, (squadByDiv.get(s.division) || 0) + 1);
  const squadBits = [...squadByDiv.entries()].map(([d, n]) => `${d} ${n}`).join(', ');
  lines.push(`Cheer squads: ${plan.cheerSquads.length}${squadBits ? ` (${squadBits})` : ''}`);
  lines.push(`Cheer slots: ${plan.cheerSlots.length}`);
  const cheerDays = [1, 2, 3, 4].filter((d) => plan.cheerPracticeByDay[d]).map((d) => `${DAY_SHORT[d]} ${plan.cheerPracticeByDay[d]}`).join(', ');
  lines.push(`Cheer practice slots: ${cheerDays || 'none'} (${plan.cheerPracticeSlots.length} weekly, ${plan.cheerPracticeDatedRows} dated rows)`);
  lines.push(plan.warnings.length ? `Warnings:\n${plan.warnings.map((w) => `- ${w}`).join('\n')}` : 'Warnings: none');
  return lines.join('\n');
}

export interface ExistingGameRef { date: string; time: string; court: string; home: string; away: string }

export function gameNaturalKey(g: { date: string; time: string; court: string; home: string; away: string }): string {
  return `${g.date}|${g.time}|${g.court}|${g.home}|${g.away}`;
}

/** seedIfEmpty names that are not already in the demo BOYS/GIRLS pools. */
const SEED_IF_EMPTY = ['Dolphins', 'Hawks', 'Saints'];
const DEMO_NAMES = new Set([...BOYS, ...GIRLS, ...SEED_IF_EMPTY].map((n) => n.toLowerCase()));

function isDemoGames(games: ExistingGameRef[]): boolean {
  const names = new Set<string>();
  for (const g of games) { names.add(g.home); names.add(g.away); }
  for (const n of names) if (!DEMO_NAMES.has(n.toLowerCase())) return false;
  const dates = [...new Set(games.map((g) => g.date))].sort();
  if (dates.length === 1) return true; // seedIfEmpty: every game is "today"
  if (dates.length === 2 && dowOf(dates[0]) === 5 && addDays(dates[0], 1) === dates[1]) return true; // one demo Fri+Sat
  return false;
}

export type ReplaceKind = 'empty' | 'season' | 'demo' | 'foreign';

/**
 * Empty, a previous run of this importer (every game is in the plan), or demo/seedIfEmpty
 * data may be replaced without --reset. Anything else is foreign and needs --reset.
 */
export function replacementDecision(existing: ExistingGameRef[], planGames: ExistingGameRef[]): { ok: boolean; kind: ReplaceKind; reason?: string } {
  if (existing.length === 0) return { ok: true, kind: 'empty' };
  const planKeys = new Set(planGames.map(gameNaturalKey));
  const foreign = existing.filter((g) => !planKeys.has(gameNaturalKey(g)));
  if (foreign.length === 0) return { ok: true, kind: 'season' };
  if (isDemoGames(existing)) return { ok: true, kind: 'demo' };
  return {
    ok: false,
    kind: 'foreign',
    reason: `Refusing to replace ${foreign.length} game(s) that were not created by this importer and are not demo data. Re-run with --reset to delete them and import the 2027 season.`,
  };
}
