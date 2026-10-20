import pg from 'pg';
import { demoWeekend, demoSeedPlan, gradeOrder, LEAGUE_TZ, hourSlot } from './schedule.js';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  options: `-c TimeZone=${process.env.TZ || 'UTC'}`, // league-local times for CSV + "up next"
});

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  short_name TEXT,
  primary_color TEXT NOT NULL DEFAULT '#333333',
  secondary_color TEXT NOT NULL DEFAULT '#ffffff',
  logo_url TEXT,
  logo_data BYTEA,
  logo_mime TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS courts (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  location TEXT,
  current_game_id INT
);
CREATE TABLE IF NOT EXISTS games (
  id SERIAL PRIMARY KEY,
  court_id INT REFERENCES courts(id) ON DELETE SET NULL,
  home_team_id INT NOT NULL REFERENCES teams(id),
  away_team_id INT NOT NULL REFERENCES teams(id),
  scheduled_at TIMESTAMPTZ,
  division TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  theme JSONB NOT NULL DEFAULT '{}'::jsonb,   -- per-matchup overrides: homeName, homeColor, awayColor...
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  history JSONB,                              -- {present, past, future} snapshot (server-authoritative)
  final_home INT,
  final_away INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS game_events (
  id BIGSERIAL PRIMARY KEY,
  game_id INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  client_cmd_id TEXT,
  actor TEXT,
  command JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS game_events_game ON game_events(game_id, seq);
-- Natural key for idempotent schedule imports (one game per court + start time + teams).
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS games_natural_key ON games (court_id, scheduled_at, home_team_id, away_team_id) NULLS NOT DISTINCT;
EXCEPTION WHEN unique_violation THEN RAISE WARNING 'games_natural_key not created: existing duplicate games; remove them and restart';
END $$;
-- Grades: teams are organized by grade, then name ("5th Grade" + order 5 for sorting).
ALTER TABLE teams ADD COLUMN IF NOT EXISTS grade TEXT, ADD COLUMN IF NOT EXISTS grade_order INT NOT NULL DEFAULT 100;
-- Team names are unique per grade (2nd Grade Eagles and 5th Grade Eagles can both exist), case-insensitive.
-- Safe on old data: the old global unique already guarantees no duplicates; the old constraint is dropped after the new index exists.
-- Gender / division (2026-10): Boys or Girls. Names are unique per grade + gender + name (case-insensitive).
-- Safe migration: the new key is a superset of the old ones (global name, then grade + name), so existing rows
-- always satisfy it; it is created first and only then the older, stricter constraints are dropped.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS gender TEXT CHECK (gender IS NULL OR gender IN ('Boys', 'Girls'));
CREATE UNIQUE INDEX IF NOT EXISTS teams_grade_gender_name_uk ON teams (COALESCE(grade, ''), COALESCE(gender, ''), lower(name));
DROP INDEX IF EXISTS teams_grade_name_uk;
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_name_key;
-- Season colors (one dark + one light for every team) and other league settings.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings(key, value) VALUES ('season_name', '2026–27 Upward'), ('season_dark', '#800000'), ('season_light', '#ffc72c') ON CONFLICT (key) DO NOTHING;
-- Per game: which side wears dark (default home = light, away = dark), optional cheer squads per side.
ALTER TABLE games ADD COLUMN IF NOT EXISTS swap_colors BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE games ADD COLUMN IF NOT EXISTS home_cheer TEXT, ADD COLUMN IF NOT EXISTS away_cheer TEXT,
  ADD COLUMN IF NOT EXISTS home_cheer_logo_url TEXT, ADD COLUMN IF NOT EXISTS away_cheer_logo_url TEXT,
  ADD COLUMN IF NOT EXISTS home_cheer_logo_data BYTEA, ADD COLUMN IF NOT EXISTS away_cheer_logo_data BYTEA,
  ADD COLUMN IF NOT EXISTS home_cheer_logo_mime TEXT, ADD COLUMN IF NOT EXISTS away_cheer_logo_mime TEXT;
-- One cheer squad per GAME (2026-10, replaces home_cheer/away_cheer): name + optional logo URL or upload.
-- The legacy per-side columns are migrated once in migrateCheer() and then cleared (kept so old builds still start).
ALTER TABLE games ADD COLUMN IF NOT EXISTS cheer TEXT, ADD COLUMN IF NOT EXISTS cheer_logo_url TEXT,
  ADD COLUMN IF NOT EXISTS cheer_logo_data BYTEA, ADD COLUMN IF NOT EXISTS cheer_logo_mime TEXT;
-- Scorekeeping flow: statuses scheduled / active / complete (older builds: live / final).
UPDATE games SET status='active' WHERE status='live';
UPDATE games SET status='complete' WHERE status='final';
-- Old dev data may hold several started games per court: keep the one on court, complete the rest.
UPDATE games g SET status='complete', final_home=COALESCE(final_home, (history->'present'->'home'->>'score')::int), final_away=COALESCE(final_away, (history->'present'->'away'->>'score')::int)
  WHERE status='active' AND court_id IS NOT NULL AND id <> COALESCE((SELECT current_game_id FROM courts c WHERE c.id=g.court_id), -1);
-- Only one active game per court (enforced by the database).
CREATE UNIQUE INDEX IF NOT EXISTS games_one_active_per_court ON games(court_id) WHERE status='active';
-- Weekly court QR codes: bumping the version invalidates every older printed code for that court.
ALTER TABLE courts ADD COLUMN IF NOT EXISTS qr_version INT NOT NULL DEFAULT 1;
-- Shared gym floor (2026-10): courts a court can't overlap in time (slugs, symmetric), per-game length.
ALTER TABLE courts ADD COLUMN IF NOT EXISTS conflicts_with TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE games ADD COLUMN IF NOT EXISTS duration_min INT CHECK (duration_min IS NULL OR duration_min BETWEEN 1 AND 600);
DO $$ BEGIN
  ALTER TABLE courts ADD CONSTRAINT courts_current_game_fk FOREIGN KEY (current_game_id) REFERENCES games(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Locker rooms + coaches + cheer by time slot (2026-10, docs/plans/locker-rooms-coaches.md).
-- Locker rooms change every week: free text per game and side ('CH', '2'), no default.
ALTER TABLE games ADD COLUMN IF NOT EXISTS home_locker TEXT CHECK (home_locker IS NULL OR length(home_locker) <= 8),
  ADD COLUMN IF NOT EXISTS away_locker TEXT CHECK (away_locker IS NULL OR length(away_locker) <= 8);
-- One coach per team for the whole season, first name only (pages render "Coach <name>"; never on the scorekeeper).
ALTER TABLE teams ADD COLUMN IF NOT EXISTS coach TEXT CHECK (coach IS NULL OR length(coach) <= 30);
-- Cheer squads (season-long: name, coach first name, logo). The logo moved here from games.cheer_logo_*.
CREATE TABLE IF NOT EXISTS cheer_squads (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  coach TEXT CHECK (coach IS NULL OR length(coach) <= 30),
  logo_url TEXT,
  logo_data BYTEA,
  logo_mime TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cheer_squads_name_uk ON cheer_squads (lower(name));
-- One optional squad per scheduled 1-hour block (league-local date + start on the hour), shared by West, East
-- and Full. A game belongs to the slot its start falls in (09:05 -> 09:00). No row = no cheer that hour.
CREATE TABLE IF NOT EXISTS cheer_slots (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  slot_start TIME NOT NULL CHECK (slot_start = date_trunc('hour', slot_start)),
  squad_id INT NOT NULL REFERENCES cheer_squads(id),
  locker TEXT CHECK (locker IS NULL OR length(locker) <= 8),
  UNIQUE (date, slot_start)
);
-- games.cheer, cheer_logo_url/_data/_mime are READ-ONLY from here on: the backfill below reads them once and
-- nothing writes them. Drop them once /api/warnings shows no cheer-slot-conflict and an export/import round-trip
-- of cheer_slots.csv matches (planned for the release after the next import cycle).
`;

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA);
  await migrateFloorCourts();
  await migrateCheer();
  await migrateCheerSlots();
}

/** SQL for a game's cheer slot (league-local date + start floored to the hour). $tz is a bind parameter. */
export const slotDateSql = (col: string, tz: string) => `(${col} AT TIME ZONE ${tz})::date`;
export const slotStartSql = (col: string, tz: string) => `date_trunc('hour', ${col} AT TIME ZONE ${tz})::time`;

type Q = { query: (text: string, params?: any[]) => Promise<any> };
export type CheerBackfill = { squads: number; slots: number; conflicts: { date: string; start: string; candidates: string[] }[]; ran: boolean };

/**
 * One-time backfill of cheer_squads + cheer_slots from the old per-game games.cheer values (2026-10).
 * - squads: one per distinct trimmed name (case-insensitive); the logo comes from the first game that had one
 *   (uploads preferred over URLs).
 * - slots: games grouped by league-local date + hour; a slot is created only when exactly one squad is in it.
 *   Two or more different squads in one hour = conflict: no slot, reported (see legacyCheerConflicts) so an
 *   admin can pick. Safe to re-run: guarded by settings.cheer_slots_backfill and ON CONFLICT DO NOTHING.
 */
export async function migrateCheerSlots(force = false): Promise<CheerBackfill> {
  const done = (await pool.query(`SELECT value FROM settings WHERE key='cheer_slots_backfill'`)).rows[0];
  if (done && !force) return { squads: 0, slots: 0, conflicts: [], ran: false };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const squads = (await client.query(`INSERT INTO cheer_squads(name, logo_url, logo_data, logo_mime)
      SELECT DISTINCT ON (lower(trim(cheer))) left(trim(cheer), 40), cheer_logo_url, cheer_logo_data, cheer_logo_mime FROM games
      WHERE nullif(trim(cheer), '') IS NOT NULL
      ORDER BY lower(trim(cheer)), (cheer_logo_data IS NULL), (cheer_logo_url IS NULL), id
      ON CONFLICT ((lower(name))) DO NOTHING`)).rowCount ?? 0;
    const slots = (await client.query(`WITH g AS (
        SELECT ${slotDateSql('scheduled_at', '$1')} AS d, ${slotStartSql('scheduled_at', '$1')} AS s, lower(left(trim(cheer), 40)) AS k
        FROM games WHERE nullif(trim(cheer), '') IS NOT NULL AND scheduled_at IS NOT NULL),
      one AS (SELECT d, s, min(k) AS k FROM g GROUP BY d, s HAVING count(DISTINCT k) = 1)
      INSERT INTO cheer_slots(date, slot_start, squad_id) SELECT one.d, one.s, q.id FROM one JOIN cheer_squads q ON lower(q.name) = one.k
      ON CONFLICT (date, slot_start) DO NOTHING`, [LEAGUE_TZ])).rowCount ?? 0;
    await client.query(`INSERT INTO settings(key, value) VALUES ('cheer_slots_backfill', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [new Date().toISOString()]);
    await client.query('COMMIT');
    const conflicts = await legacyCheerConflicts();
    if (squads || slots) console.log(`Cheer slots migration: ${squads} squad(s), ${slots} slot(s) from per-game cheer.`);
    for (const c of conflicts) console.log(`Cheer slots migration: CONFLICT ${c.date} ${c.start}: ${c.candidates.join(', ')} (no slot created; pick one in Admin)`);
    return { squads, slots, conflicts, ran: true };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/** Hours where the old per-game data names 2+ different squads and no slot has been set yet. */
export async function legacyCheerConflicts(): Promise<{ date: string; start: string; candidates: string[] }[]> {
  const { rows } = await pool.query(`SELECT to_char(${slotDateSql('g.scheduled_at', '$1')}, 'YYYY-MM-DD') AS date,
      to_char(${slotStartSql('g.scheduled_at', '$1')}, 'HH24:MI') AS start,
      array_agg(DISTINCT left(trim(g.cheer), 40) ORDER BY left(trim(g.cheer), 40)) AS candidates
    FROM games g WHERE nullif(trim(g.cheer), '') IS NOT NULL AND g.scheduled_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM cheer_slots cs WHERE cs.date = ${slotDateSql('g.scheduled_at', '$1')} AND cs.slot_start = ${slotStartSql('g.scheduled_at', '$1')})
    GROUP BY 1, 2 HAVING count(DISTINCT lower(left(trim(g.cheer), 40))) > 1 ORDER BY 1, 2`, [LEAGUE_TZ]);
  return rows;
}

/** Find or create a squad by name (case-insensitive). */
export async function squadId(q: Q, name: string): Promise<number> {
  const ex = (await q.query('SELECT id FROM cheer_squads WHERE lower(name)=lower($1)', [name])).rows[0];
  if (ex) return ex.id;
  return (await q.query('INSERT INTO cheer_squads(name) VALUES ($1) ON CONFLICT ((lower(name))) DO UPDATE SET name=cheer_squads.name RETURNING id', [name])).rows[0].id;
}
/** Set the squad of a slot (date YYYY-MM-DD, start HH:00); keeps the slot's locker. Returns true if it changed. */
export async function setSlotSquad(q: Q, date: string, start: string, sid: number): Promise<boolean> {
  const r = await q.query(`INSERT INTO cheer_slots(date, slot_start, squad_id) VALUES ($1, $2, $3)
    ON CONFLICT (date, slot_start) DO UPDATE SET squad_id=EXCLUDED.squad_id WHERE cheer_slots.squad_id IS DISTINCT FROM EXCLUDED.squad_id`, [date, start, sid]);
  return (r.rowCount ?? 0) > 0;
}
/** The league-local slot (date, HH:00) of a game, or null when it isn't scheduled. */
export async function gameSlot(q: Q, gameId: number): Promise<{ date: string; start: string } | null> {
  const r = (await q.query(`SELECT to_char(${slotDateSql('scheduled_at', '$2')}, 'YYYY-MM-DD') AS date, to_char(${slotStartSql('scheduled_at', '$2')}, 'HH24:MI') AS start
    FROM games WHERE id=$1 AND scheduled_at IS NOT NULL`, [gameId, LEAGUE_TZ])).rows[0];
  return r || null;
}

/**
 * Per-side cheer squads -> one per game. Takes whichever side is set (with its logo); if both are set, keeps HOME
 * and logs the dropped away squad. Then clears the legacy columns so this runs once per row. Safe to repeat.
 */
export async function migrateCheer(): Promise<number> {
  const { rows } = await pool.query(`SELECT id, home_cheer, away_cheer FROM games WHERE home_cheer IS NOT NULL OR away_cheer IS NOT NULL`);
  for (const r of rows) {
    if (r.home_cheer && r.away_cheer) console.log(`Cheer migration: game #${r.id} had two squads ("${r.home_cheer}" home, "${r.away_cheer}" away); kept "${r.home_cheer}" (home).`);
    const side = r.home_cheer ? 'home' : 'away';
    await pool.query(`UPDATE games SET cheer=COALESCE(cheer, ${side}_cheer), cheer_logo_url=CASE WHEN cheer IS NULL THEN ${side}_cheer_logo_url ELSE cheer_logo_url END,
      cheer_logo_data=CASE WHEN cheer IS NULL THEN ${side}_cheer_logo_data ELSE cheer_logo_data END, cheer_logo_mime=CASE WHEN cheer IS NULL THEN ${side}_cheer_logo_mime ELSE cheer_logo_mime END,
      home_cheer=NULL, away_cheer=NULL, home_cheer_logo_url=NULL, away_cheer_logo_url=NULL, home_cheer_logo_data=NULL, away_cheer_logo_data=NULL, home_cheer_logo_mime=NULL, away_cheer_logo_mime=NULL
      WHERE id=$1`, [r.id]);
  }
  if (rows.length) console.log(`Cheer migration: ${rows.length} game(s) moved to one squad per game.`);
  return rows.length;
}

/**
 * One-time dev-data migration to the real gym (Full / West / East on one floor). Safe to run on every
 * start and on a fresh database (no-op there). Only acts when old POC courts court-1/court-2 exist:
 * court-1 -> west, court-2 -> east (keeping their games and history), then adds full with
 * conflicts_with {west,east}. Courts created any other way are never touched.
 */
async function migrateFloorCourts(): Promise<void> {
  const has = async (s: string) => (await pool.query('SELECT 1 FROM courts WHERE slug=$1', [s])).rowCount! > 0;
  if (!(await has('court-1')) && !(await has('court-2'))) return;
  for (const [from, to, name] of [['court-1', 'west', 'West'], ['court-2', 'east', 'East']]) {
    if ((await has(from)) && !(await has(to))) await pool.query(`UPDATE courts SET slug=$2, name=$3, location='Main gym (half court)' WHERE slug=$1`, [from, to, name]);
  }
  if (!(await has('full'))) await pool.query(`INSERT INTO courts(slug, name, location, conflicts_with) VALUES ('full','Full','Main gym (full court)','{west,east}')`);
  console.log('Migrated dev courts court-1/court-2 to west/east and added full (one gym floor).');
}

const SEED_TEAMS: [string, string, string, number][] = [ // name, short, grade, grade order
  ['Bears', 'BEA', '2nd Grade', 2], ['Dolphins', 'DOL', '2nd Grade', 2],
  ['Hawks', 'HAW', '3rd Grade', 3], ['Tigers', 'TIG', '3rd Grade', 3],
  ['Rams', 'RAM', '4th Grade', 4], ['Knights', 'KNI', '4th Grade', 4], ['Saints', 'SAI', '4th Grade', 4], ['Warriors', 'WAR', '4th Grade', 4],
  ['Eagles', 'EAG', '5th Grade', 5], ['Lions', 'LIO', '5th Grade', 5],
];

export async function seedIfEmpty(): Promise<boolean> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM teams');
  if (rows[0].n > 0) return false;
  for (const [name, short, grade, order] of SEED_TEAMS) {
    await pool.query('INSERT INTO teams(name, short_name, grade, grade_order) VALUES ($1,$2,$3,$4)', [name, short, grade, order]);
  }
  // One gym floor: Full is used on its own; West and East (half courts) run at the same time.
  await pool.query(`INSERT INTO courts(slug, name, location, conflicts_with) VALUES
    ('full','Full','Main gym (full court)','{west,east}'),('west','West','Main gym (half court)','{}'),('east','East','Main gym (half court)','{}')
    ON CONFLICT (slug) DO NOTHING`);
  const id = async (n: string) => (await pool.query('SELECT id FROM teams WHERE name=$1', [n])).rows[0].id;
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const at = (h: number, m = 0) => new Date(day.getTime() + (h * 60 + m) * 60_000);
  const games: [string, string, string, Date, string][] = [
    // A realistic Saturday: West + East block (younger grades side by side), then a Full block. No overlaps.
    ['west', 'Bears', 'Dolphins', at(9), '2nd Grade'],
    ['east', 'Hawks', 'Tigers', at(9), '3rd Grade'],
    ['west', 'Rams', 'Knights', at(10), '4th Grade'],
    ['east', 'Saints', 'Warriors', at(10), '4th Grade'],
    ['full', 'Eagles', 'Lions', at(11), '5th Grade'],
    ['full', 'Knights', 'Saints', at(12), '4th Grade'],
    ['full', 'Lions', 'Eagles', at(13), '5th Grade'],
  ];
  for (const [court, h, a, when, div] of games) {
    await pool.query(
      `INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, division)
       VALUES ((SELECT id FROM courts WHERE slug=$1), $2, $3, $4, $5)`,
      [court, await id(h), await id(a), when, div]);
  }
  // Some time slots have a cheer squad, some don't (one squad per hour, shared by every court).
  for (const [squad, h, a] of [['Eagles Cheer', 'Eagles', 'Lions'], ['Knights Cheer', 'Knights', 'Saints']]) {
    const g = (await pool.query('SELECT id FROM games WHERE home_team_id=$1 AND away_team_id=$2', [await id(h), await id(a)])).rows[0];
    const slot = g && (await gameSlot(pool, g.id));
    if (slot) await setSlotSquad(pool, slot.date, slot.start, await squadId(pool, squad));
  }
  return true;
}

/**
 * Demo seed for a laptop demo (SEED=demo on start, or `node dist/src/seed-demo.js`). Season 2026–27 Upward,
 * Maroon/Gold, Lenexa Baptist Church. The demo weekend is chosen relative to today (America/Chicago): today if
 * it's Friday, yesterday's Friday if it's Saturday, else the upcoming Friday (see demoWeekend). The games come
 * from demoSeedPlan (schedule.ts): Fri Full Court 17:30/18:30/19:30, Sat West+East 08:00–15:00 (16 games,
 * 2nd–4th), Sat Full Court 16:30/17:30/18:30 (5th–6th). Every team plays exactly once. All games stay scheduled.
 * mode 'if-needed': seeds only when no game is scheduled in the demo weekend (wipes stale demo data).
 * mode 'reset': always wipes teams, courts, games and events, then seeds.
 */
export async function seedDemo(mode: 'if-needed' | 'reset', nowMs = Date.now()): Promise<boolean> {
  const w = demoWeekend(nowMs, 'America/Chicago');
  if (mode === 'if-needed') {
    const n = (await pool.query(`SELECT count(*)::int AS n FROM games WHERE (scheduled_at AT TIME ZONE 'America/Chicago')::date BETWEEN $1::date AND $2::date`, [w.fri, w.sat])).rows[0].n;
    if (n > 0) return false;
  }
  const plan = demoSeedPlan(w);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE game_events, cheer_slots, cheer_squads, games, teams, courts RESTART IDENTITY CASCADE');
    for (const [k, v] of [['season_name', '2026–27 Upward'], ['season_dark', '#800000'], ['season_light', '#ffc72c']]) {
      await client.query('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
    }
    await client.query(`INSERT INTO courts(slug, name, location, conflicts_with) VALUES
      ('full','Full','Main gym (full court)','{west,east}'),('west','West','Main gym (half court)','{}'),('east','East','Main gym (half court)','{}')`);
    const team = async (name: string, grade: string, gender: string, coach: string) => (await client.query(
      'INSERT INTO teams(name, short_name, grade, grade_order, gender, coach) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [name, name.slice(0, 3).toUpperCase(), grade, gradeOrder(grade), gender, coach])).rows[0].id;
    for (const g of plan) {
      const h = await team(g.home, g.grade, g.gender, g.homeCoach), a = await team(g.away, g.grade, g.gender, g.awayCoach);
      await client.query(`INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, division, home_locker, away_locker)
        VALUES ((SELECT id FROM courts WHERE slug=$1), $2, $3, ($4 || ' ' || $5)::timestamp AT TIME ZONE 'America/Chicago', $6, $7, $8)`,
      [g.court, h, a, g.date, g.time, `${g.grade} ${g.gender}`, g.homeLocker, g.awayLocker]);
      if (g.cheer) { // one squad per hour, shared by every court
        const sid = await squadId(client, g.cheer);
        await client.query('UPDATE cheer_squads SET coach=$2 WHERE id=$1', [sid, g.cheerCoach ?? null]);
        await setSlotSquad(client, g.date, hourSlot(g.time), sid);
        await client.query('UPDATE cheer_slots SET locker=$3 WHERE date=$1 AND slot_start=$2', [g.date, hourSlot(g.time), g.cheerLocker ?? null]);
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return true;
}
