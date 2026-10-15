import pg from 'pg';

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
DO $$ BEGIN
  ALTER TABLE courts ADD CONSTRAINT courts_current_game_fk FOREIGN KEY (current_game_id) REFERENCES games(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA);
}

const SEED_TEAMS = [
  ['Lions', 'LIO', '#7a1020', '#f2b705'],
  ['Eagles', 'EAG', '#0d2c6b', '#4fc3f7'],
  ['Saints', 'SAI', '#14532d', '#a3e635'],
  ['Warriors', 'WAR', '#4c1d95', '#f0abfc'],
  ['Rams', 'RAM', '#7c2d12', '#fdba74'],
  ['Knights', 'KNI', '#1f2937', '#e5e7eb'],
];

export async function seedIfEmpty(): Promise<boolean> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM teams');
  if (rows[0].n > 0) return false;
  for (const [name, short, p, s] of SEED_TEAMS) {
    await pool.query('INSERT INTO teams(name, short_name, primary_color, secondary_color) VALUES ($1,$2,$3,$4)', [name, short, p, s]);
  }
  await pool.query(`INSERT INTO courts(slug, name, location) VALUES ('court-1','Court 1','Main gym'),('court-2','Court 2','Fellowship hall')`);
  const id = async (n: string) => (await pool.query('SELECT id FROM teams WHERE name=$1', [n])).rows[0].id;
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const at = (h: number, m = 0) => new Date(day.getTime() + (h * 60 + m) * 60_000);
  const games: [string, string, string, Date, string][] = [
    ['court-1', 'Lions', 'Eagles', at(10, 30), '5th-6th Grade'],
    ['court-1', 'Saints', 'Warriors', at(11, 30), '5th-6th Grade'],
    ['court-1', 'Rams', 'Knights', at(12, 30), '5th-6th Grade'],
    ['court-2', 'Rams', 'Saints', at(10, 30), '3rd-4th Grade'],
    ['court-2', 'Knights', 'Lions', at(11, 30), '3rd-4th Grade'],
  ];
  for (const [court, h, a, when, div] of games) {
    await pool.query(
      `INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, division)
       VALUES ((SELECT id FROM courts WHERE slug=$1), $2, $3, $4, $5)`,
      [court, await id(h), await id(a), when, div]);
  }
  return true;
}
