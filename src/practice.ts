// Mon–Thu practice schedule (fixed weekly; Sage's mockups + data-needs.md in deliverables/mockups/practice).
// Aaron's answers: cheer squads use their room all evening (no times); a team keeps one court and a squad one room all
// season ("28/30" is one room); basketball slots are 1 hour on a per-day range (Wed can be 4:30–6:30); a night is all
// practice or all games. Tables are additive (CREATE IF NOT EXISTS); the schedule is replaced as a whole on save.
import type pg from 'pg';

export const PRACTICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS practice_days (
  day_of_week SMALLINT PRIMARY KEY CHECK (day_of_week BETWEEN 1 AND 4),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL CHECK (end_time > start_time)
);
CREATE TABLE IF NOT EXISTS practice_slots (
  id SERIAL PRIMARY KEY,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 4),
  kind TEXT NOT NULL CHECK (kind IN ('basketball','cheer')),
  start_time TIME,
  court TEXT CHECK (court IN ('west1','west2','east1','east2')),
  room TEXT CHECK (room IS NULL OR length(room) BETWEEN 1 AND 40),
  team_id INT REFERENCES teams(id) ON DELETE CASCADE,
  squad_id INT REFERENCES cheer_squads(id) ON DELETE CASCADE,
  CHECK ((kind = 'basketball' AND start_time IS NOT NULL AND court IS NOT NULL AND team_id IS NOT NULL AND room IS NULL AND squad_id IS NULL)
      OR (kind = 'cheer' AND room IS NOT NULL AND squad_id IS NOT NULL AND start_time IS NULL AND court IS NULL AND team_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS practice_court_once ON practice_slots(day_of_week, start_time, court) WHERE kind = 'basketball';
CREATE UNIQUE INDEX IF NOT EXISTS practice_team_once ON practice_slots(day_of_week, start_time, team_id) WHERE kind = 'basketball';
CREATE UNIQUE INDEX IF NOT EXISTS practice_room_once ON practice_slots(day_of_week, lower(room)) WHERE kind = 'cheer';
CREATE UNIQUE INDEX IF NOT EXISTS practice_squad_once ON practice_slots(day_of_week, squad_id) WHERE kind = 'cheer';
`;

export const COURTS = ['west1', 'west2', 'east1', 'east2'] as const;
export const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
export interface PDay { day: number; start: string; end: string }
export interface PBall { day: number; start: string; court: string; teamId: number }
export interface PCheer { day: number; room: string; squadId: number }
export interface PSchedule { days: PDay[]; basketball: PBall[]; cheer: PCheer[] }

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
export const fromMin = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
/** 1-hour slot starts for a day range: 17:00–21:00 -> 17,18,19,20; 16:30–18:30 -> 16:30, 17:30. */
export const slotStarts = (start: string, end: string) => { const out: string[] = []; for (let t = toMin(start); t + 60 <= toMin(end); t += 60) out.push(fromMin(t)); return out; };
const roomKey = (r: string) => r.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Normalize + check a whole weekly schedule. Returns { schedule, errors } (errors block the save):
 * day range (Mon–Thu, HH:MM, end after start, at least one 1-hour slot); basketball on a slot start of its day, a known
 * court, a court once per slot, a team once per slot, and one court per team all season; cheer: a room once per night,
 * a squad once per night, one room per squad all season. Team/squad existence is checked by the DB (FK).
 */
export function validatePractice(input: any): { schedule: PSchedule; errors: string[] } {
  const errors: string[] = [];
  const arr = (v: any) => (Array.isArray(v) ? v : []);
  const day = (v: any) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 0; };
  const days: PDay[] = [];
  for (const d of arr(input?.days)) {
    const n = day(d?.day), s = String(d?.start ?? '').trim(), e = String(d?.end ?? '').trim();
    if (!n) { errors.push(`day ${d?.day}: practice days are Mon–Thu (1–4)`); continue; }
    if (!HM.test(s) || !HM.test(e)) { errors.push(`${DAY_NAMES[n]}: hours must be HH:MM`); continue; }
    if (!slotStarts(s, e).length) { errors.push(`${DAY_NAMES[n]}: ${s}–${e} has no full 1-hour slot`); continue; }
    if (days.some((x) => x.day === n)) { errors.push(`${DAY_NAMES[n]}: hours given twice`); continue; }
    days.push({ day: n, start: s, end: e });
  }
  const basketball: PBall[] = [], cheer: PCheer[] = [];
  const teamCourt = new Map<number, string>(), squadRoom = new Map<number, string>();
  for (const b of arr(input?.basketball)) {
    const n = day(b?.day), s = String(b?.start ?? '').trim(), c = String(b?.court ?? ''), t = Number(b?.teamId);
    const dn = DAY_NAMES[n] || `day ${b?.day}`;
    const dd = days.find((x) => x.day === n);
    if (!dd) { errors.push(`${dn}: set the practice hours before assigning courts`); continue; }
    if (!slotStarts(dd.start, dd.end).includes(s)) { errors.push(`${dn} ${s}: not a slot start (${slotStarts(dd.start, dd.end).join(', ')})`); continue; }
    if (!(COURTS as readonly string[]).includes(c)) { errors.push(`${dn} ${s}: unknown court "${c}"`); continue; }
    if (!Number.isInteger(t) || t <= 0) { errors.push(`${dn} ${s} ${c}: pick a team`); continue; }
    if (basketball.some((x) => x.day === n && x.start === s && x.court === c)) { errors.push(`${dn} ${s}: ${c} is double-booked`); continue; }
    if (basketball.some((x) => x.day === n && x.start === s && x.teamId === t)) { errors.push(`${dn} ${s}: a team is on two courts`); continue; }
    if (teamCourt.has(t) && teamCourt.get(t) !== c) { errors.push(`${dn} ${s}: a team keeps one court all season (already on ${teamCourt.get(t)})`); continue; }
    teamCourt.set(t, c); basketball.push({ day: n, start: s, court: c, teamId: t });
  }
  for (const q of arr(input?.cheer)) {
    const n = day(q?.day), r = String(q?.room ?? '').trim().replace(/\s+/g, ' '), id = Number(q?.squadId);
    const dn = DAY_NAMES[n] || `day ${q?.day}`;
    if (!n) { errors.push(`${dn}: practice days are Mon–Thu`); continue; }
    if (!days.some((x) => x.day === n)) { errors.push(`${dn}: set the practice hours before assigning cheer rooms`); continue; }
    if (!r || r.length > 40) { errors.push(`${dn}: room name is required (40 characters max)`); continue; }
    if (!Number.isInteger(id) || id <= 0) { errors.push(`${dn} ${r}: pick a squad`); continue; }
    if (cheer.some((x) => x.day === n && roomKey(x.room) === roomKey(r))) { errors.push(`${dn}: ${r} is double-booked`); continue; }
    if (cheer.some((x) => x.day === n && x.squadId === id)) { errors.push(`${dn}: a squad is in two rooms`); continue; }
    if (squadRoom.has(id) && roomKey(squadRoom.get(id)!) !== roomKey(r)) { errors.push(`${dn}: a squad keeps one room all season (already ${squadRoom.get(id)})`); continue; }
    squadRoom.set(id, r); cheer.push({ day: n, room: r, squadId: id });
  }
  return { schedule: { days, basketball, cheer }, errors };
}

type Q = pg.Pool | pg.PoolClient;
/** Replace the whole weekly schedule (caller runs this in a transaction). */
export async function savePractice(q: Q, s: PSchedule): Promise<void> {
  await q.query('DELETE FROM practice_slots'); await q.query('DELETE FROM practice_days');
  for (const d of s.days) await q.query('INSERT INTO practice_days(day_of_week, start_time, end_time) VALUES ($1,$2,$3)', [d.day, d.start, d.end]);
  for (const b of s.basketball) await q.query(`INSERT INTO practice_slots(day_of_week, kind, start_time, court, team_id) VALUES ($1,'basketball',$2,$3,$4)`, [b.day, b.start, b.court, b.teamId]);
  for (const c of s.cheer) await q.query(`INSERT INTO practice_slots(day_of_week, kind, room, squad_id) VALUES ($1,'cheer',$2,$3)`, [c.day, c.room, c.squadId]);
}

const teamLogo = (id: number, hasData: boolean, url: string | null) => (hasData ? `/logos/${id}` : url || null);
const squadLogo = (id: number, hasData: boolean, url: string | null) => (hasData ? `/logos/squad/${id}` : url || null);
/** The weekly schedule for the displays (names, first-name coaches, logos) and the admin screen (ids). */
export async function loadPractice(q: Q) {
  const days = (await q.query(`SELECT day_of_week AS day, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS "end" FROM practice_days ORDER BY 1`)).rows;
  const basketball = (await q.query(`SELECT p.day_of_week AS day, to_char(p.start_time,'HH24:MI') AS start, p.court, t.id, t.name, t.coach, t.grade, t.gender, t.logo_url, (t.logo_data IS NOT NULL) AS has_data
    FROM practice_slots p JOIN teams t ON t.id = p.team_id WHERE p.kind='basketball' ORDER BY 1, 2, 3`)).rows
    .map((r) => ({ day: r.day, start: r.start, court: r.court, teamId: r.id, team: { name: r.name, coach: r.coach || null, division: [r.grade, r.gender].filter(Boolean).join(' ') || null, logo: teamLogo(r.id, r.has_data, r.logo_url) } }));
  const cheer = (await q.query(`SELECT p.day_of_week AS day, p.id AS slot_id, p.room, q.id, q.name, q.coach, q.logo_url, (q.logo_data IS NOT NULL) AS has_data
    FROM practice_slots p JOIN cheer_squads q ON q.id = p.squad_id WHERE p.kind='cheer' ORDER BY 1, lower(p.room)`)).rows
    .map((r) => ({ day: r.day, slotId: r.slot_id, room: r.room, squadId: r.id, squad: { name: r.name, coach: r.coach || null, logo: squadLogo(r.id, r.has_data, r.logo_url) } }));
  return { days, basketball, cheer };
}

/** Demo week from the demo teams: Mon + Tue 5–9 PM (16 teams each), Wed 4:30–6:30 (8), Thu 5–6 PM (4) = 44 teams,
 *  each once a week on one court; the 4 squads Mon + Thu in fixed rooms. Fills only an empty schedule. */
export const DEMO_PRACTICE_DAYS: PDay[] = [{ day: 1, start: '17:00', end: '21:00' }, { day: 2, start: '17:00', end: '21:00' }, { day: 3, start: '16:30', end: '18:30' }, { day: 4, start: '17:00', end: '18:00' }];
export const DEMO_CHEER_ROOMS = ['Room 20', 'Room 28/30', 'Kids Street', 'Foundry'];
export async function seedPracticeDemo(q: Q): Promise<boolean> {
  if ((await q.query('SELECT 1 FROM practice_days UNION ALL SELECT 1 FROM practice_slots LIMIT 1')).rowCount) return false;
  const teams = (await q.query('SELECT id FROM teams ORDER BY grade_order NULLS LAST, gender, id')).rows.map((r) => r.id as number);
  const squads = (await q.query('SELECT id FROM cheer_squads ORDER BY id')).rows.map((r) => r.id as number);
  const basketball: PBall[] = [];
  let i = 0;
  for (const d of DEMO_PRACTICE_DAYS) for (const s of slotStarts(d.start, d.end)) for (const c of COURTS) if (i < teams.length) basketball.push({ day: d.day, start: s, court: c, teamId: teams[i++] });
  const cheer: PCheer[] = [];
  for (const day of [1, 4]) squads.slice(0, DEMO_CHEER_ROOMS.length).forEach((id, k) => cheer.push({ day, room: DEMO_CHEER_ROOMS[k], squadId: id }));
  const { schedule, errors } = validatePractice({ days: DEMO_PRACTICE_DAYS, basketball, cheer });
  if (errors.length) throw new Error('demo practice: ' + errors.join('; '));
  await savePractice(q, schedule);
  return true;
}

const addDaysIso = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
/**
 * Next day the practice screens open on. Today when today's weekday has slots (of `kind`, or of either kind when
 * null) and a hours row in `days`; else the next date within 7 days whose weekday does; else today.
 * Today stays selected after the window ends — this helper does not look at the clock.
 * With a season range: before it, the first practice date inside it; past its last practice, over: true (idle).
 * Keep in step with practiceDisplayDay in public/practice-view.js.
 */
export function practiceDisplayOf(
  data: { days?: { day: number }[]; basketball?: { day: number }[]; cheer?: { day: number }[]; range?: PRange | null } | null,
  kind: 'basketball' | 'cheer' | null,
  today: string,
  todayDow: number,
): { date: string; dow: number; today: boolean; over?: boolean } {
  const lists = kind ? [data?.[kind] || []] : [data?.basketball || [], data?.cheer || []];
  const open = new Set((data?.days || []).map((d) => Number(d.day)));
  const has = (dow: number) => open.has(dow) && lists.some((l) => l.some((x) => Number(x.day) === dow));
  const n = Number(todayDow);
  const dow0 = Number.isInteger(n) ? ((n % 7) + 7) % 7 : 0;
  const range = data?.range && data.range.start && data.range.end ? data.range : null;
  // Season range: before it, start the search on its first day; after it (or nothing left inside it), no practice.
  const skip = range && today < range.start ? Math.round((Date.parse(range.start + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400_000) : 0;
  for (let k = skip; k <= skip + 7; k++) {
    const dow = (dow0 + k) % 7, date = addDaysIso(today, k);
    if (range && date > range.end) break;
    if (has(dow)) return { date, dow, today: k === 0 };
  }
  return range ? { date: today, dow: dow0, today: true, over: true } : { date: today, dow: dow0, today: true };
}

export type PRange = { start: string; end: string };
/** Season practice dates (settings practice_start/practice_end, written by the season importer); null = weekly, no range (demo). */
export async function loadPracticeRange(q: Q): Promise<PRange | null> {
  const r = (await q.query(`SELECT key, value FROM settings WHERE key IN ('practice_start', 'practice_end')`)).rows;
  const get = (k: string) => String(r.find((x) => x.key === k)?.value || '').trim();
  const start = get('practice_start'), end = get('practice_end');
  return /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) ? { start, end } : null;
}

const DAY3 = ['', 'Mon', 'Tue', 'Wed', 'Thu'];
/** QA r17: what a save would remove versus the saved week (a team's slot or a squad's room that is no longer there).
 *  The PUT refuses these with 409 unless the body says confirmRemove: true. */
export function droppedSlots(old: { basketball: any[]; cheer: any[] }, next: PSchedule): string[] {
  const out: string[] = [];
  for (const b of old.basketball) if (!next.basketball.some((x) => x.day === b.day && x.start === b.start && x.court === b.court && x.teamId === b.teamId))
    out.push(`${DAY3[b.day] || b.day} ${b.start} ${b.court}: ${b.team?.name || 'team ' + b.teamId} would be removed`);
  for (const c of old.cheer) if (!next.cheer.some((x) => x.day === c.day && x.squadId === c.squadId && roomKey(x.room) === roomKey(c.room)))
    out.push(`${DAY3[c.day] || c.day} cheer ${c.room}: ${c.squad?.name || 'squad ' + c.squadId} would be removed`);
  return out;
}
