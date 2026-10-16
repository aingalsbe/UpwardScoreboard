import pg from 'pg';
import { demoWeekend, demoSeedPlan, gradeOrder } from './schedule.js';

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
`;

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA);
  await migrateFloorCourts();
  await migrateCheer();
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
  // Some games have a cheer squad for a team, some don't.
  await pool.query(`UPDATE games SET cheer='Eagles Cheer' WHERE home_team_id=$1 AND away_team_id=$2`, [await id('Eagles'), await id('Lions')]);
  await pool.query(`UPDATE games SET cheer='Knights Cheer' WHERE home_team_id=$1 AND away_team_id=$2`, [await id('Knights'), await id('Saints')]);
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
    await client.query('TRUNCATE game_events, games, teams, courts RESTART IDENTITY CASCADE');
    for (const [k, v] of [['season_name', '2026–27 Upward'], ['season_dark', '#800000'], ['season_light', '#ffc72c']]) {
      await client.query('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
    }
    await client.query(`INSERT INTO courts(slug, name, location, conflicts_with) VALUES
      ('full','Full','Main gym (full court)','{west,east}'),('west','West','Main gym (half court)','{}'),('east','East','Main gym (half court)','{}')`);
    const team = async (name: string, grade: string, gender: string) => (await client.query(
      'INSERT INTO teams(name, short_name, grade, grade_order, gender) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [name, name.slice(0, 3).toUpperCase(), grade, gradeOrder(grade), gender])).rows[0].id;
    for (const g of plan) {
      const h = await team(g.home, g.grade, g.gender), a = await team(g.away, g.grade, g.gender);
      await client.query(`INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, division, cheer)
        VALUES ((SELECT id FROM courts WHERE slug=$1), $2, $3, ($4 || ' ' || $5)::timestamp AT TIME ZONE 'America/Chicago', $6, $7)`,
      [g.court, h, a, g.date, g.time, `${g.grade} ${g.gender}`, g.cheer ?? null]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return true;
}
