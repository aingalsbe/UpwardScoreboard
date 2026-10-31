// Real 2027 season import.
//   node dist/src/seed-season.js [--dry-run] [--reset]
// --dry-run parses, applies inside a transaction, prints the counts, then rolls back.
// --reset is required only when the database already has games that are neither demo
// data nor a previous run of this importer. Settings (colors, season_name) are never written.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { migrate, pool } from './db.js';
import { formatReport, loadLogos } from './logo-files.js';
import { savePractice, validatePractice } from './practice.js';
import { seasonConfig } from './season-config.js';
import {
  ExistingGameRef, SeasonImportError, SeasonPlan, buildSeasonPlan, defaultSeasonFiles, formatSeasonReport,
  gameNaturalKey, readSeasonCsvs, replacementDecision, teamKey, type SeasonFiles,
} from './season-import.js';

export class SeasonRefusedError extends SeasonImportError {
  constructor(message: string) {
    super(message);
    this.name = 'SeasonRefusedError';
  }
}

export interface SeedSeasonOptions {
  dryRun?: boolean;
  /** Delete games that are not demo data and not a previous 2027 import. */
  reset?: boolean;
  /** Server start: if the 2027 games are already loaded, leave them (and live scores) alone. */
  ifNeeded?: boolean;
  files?: SeasonFiles;
  /** Test hook. Thrown after the season rows are deleted and before inserts, inside the transaction. */
  injectError?: string;
}

export interface SeedSeasonResult {
  report: string;
  committed: boolean;
  skipped: boolean;
  plan: SeasonPlan;
  logos?: string;
}

type Q = pg.PoolClient;

async function loadExisting(q: Q): Promise<ExistingGameRef[]> {
  const { rows } = await q.query(`SELECT COALESCE(c.slug, '') AS court,
      to_char(g.scheduled_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS date,
      to_char(g.scheduled_at AT TIME ZONE 'America/Chicago', 'HH24:MI') AS time,
      h.name AS home, a.name AS away
    FROM games g
    JOIN teams h ON h.id = g.home_team_id
    JOIN teams a ON a.id = g.away_team_id
    LEFT JOIN courts c ON c.id = g.court_id
    WHERE g.scheduled_at IS NOT NULL
    ORDER BY 2, 3, 1`);
  return rows;
}

async function ensureCourts(q: Q): Promise<void> {
  await q.query(`INSERT INTO courts(slug, name, location, conflicts_with) VALUES
    ('full','Full','Main gym (full court)','{west,east}'),
    ('west','West','Main gym (half court)','{}'),
    ('east','East','Main gym (half court)','{}')
    ON CONFLICT (slug) DO NOTHING`);
}

async function clearSeason(q: Q): Promise<void> {
  await q.query('UPDATE courts SET current_game_id = NULL');
  await q.query('DELETE FROM game_events');
  await q.query('DELETE FROM game_changes');
  await q.query('DELETE FROM cheer_slots');
  await q.query('DELETE FROM practice_slots');
  await q.query('DELETE FROM practice_days');
  await q.query('DELETE FROM games');
  await q.query('DELETE FROM teams');
  await q.query('DELETE FROM cheer_squads');
}

function shortName(name: string): string {
  return name.replace(/^lady\s+/i, '').slice(0, 3).toUpperCase();
}

async function applyPlan(q: Q, plan: SeasonPlan): Promise<void> {
  const teamIds = new Map<string, number>();
  for (const t of plan.teams) {
    const id = (await q.query(
      'INSERT INTO teams(name, short_name, grade, grade_order, gender, coach) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [t.name, shortName(t.name), t.grade, t.gradeOrder, t.gender, t.coach],
    )).rows[0].id as number;
    teamIds.set(teamKey(t.division, t.name), id);
  }
  const rules = JSON.stringify({ periods: seasonConfig.PERIODS, periodLengthMs: seasonConfig.PERIOD_LENGTH_MS });
  for (const g of plan.games) {
    const home = teamIds.get(teamKey(g.division, g.home));
    const away = teamIds.get(teamKey(g.division, g.away));
    if (!home || !away) throw new SeasonImportError(`game ${g.date} ${g.time} ${g.court} is missing a team`);
    const court = (await q.query('SELECT id FROM courts WHERE slug=$1', [g.court])).rows[0]?.id;
    if (!court) throw new SeasonImportError(`court "${g.court}" is not in the database`);
    await q.query(
      `INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, division, duration_min, rules)
       VALUES ($1, $2, $3, ($4 || ' ' || $5)::timestamp AT TIME ZONE 'America/Chicago', $6, $7, $8::jsonb)`,
      [court, home, away, g.date, g.time, g.division, seasonConfig.GAME_MINUTES, rules],
    );
  }
  const squadIds = new Map<string, number>();
  for (const s of plan.cheerSquads) {
    const id = (await q.query('INSERT INTO cheer_squads(name, coach) VALUES ($1,$2) RETURNING id', [s.name, s.coach])).rows[0].id as number;
    squadIds.set(s.name, id);
  }
  for (const s of plan.cheerSlots) {
    const sid = squadIds.get(s.squad);
    if (!sid) throw new SeasonImportError(`cheer slot ${s.date} ${s.hour} has no squad "${s.squad}"`);
    await q.query('INSERT INTO cheer_slots(date, slot_start, squad_id) VALUES ($1,$2,$3)', [s.date, s.hour, sid]);
  }
  const basketball = plan.basketballSlots.map((s) => {
    const teamId = teamIds.get(teamKey(s.division, s.team));
    if (!teamId) throw new SeasonImportError(`practice slot for ${s.team} has no team row`);
    return { day: s.day, start: s.start, court: s.court, teamId };
  });
  const cheer = plan.cheerPracticeSlots.map((s) => {
    const squadId = squadIds.get(s.squad);
    if (!squadId) throw new SeasonImportError(`cheer practice for ${s.squad} has no squad row`);
    return { day: s.day, room: s.room, squadId };
  });
  const checked = validatePractice({ days: plan.practiceDays, basketball, cheer });
  if (checked.errors.length) throw new SeasonImportError(checked.errors.join('; '));
  await savePractice(q, checked.schedule);
}

async function assertCounts(q: Q, plan: SeasonPlan): Promise<void> {
  const n = async (sql: string) => (await q.query(sql)).rows[0].n as number;
  const got = {
    teams: await n('SELECT count(*)::int AS n FROM teams'),
    games: await n('SELECT count(*)::int AS n FROM games'),
    squads: await n('SELECT count(*)::int AS n FROM cheer_squads'),
    slots: await n('SELECT count(*)::int AS n FROM cheer_slots'),
    ball: await n(`SELECT count(*)::int AS n FROM practice_slots WHERE kind='basketball'`),
    cheer: await n(`SELECT count(*)::int AS n FROM practice_slots WHERE kind='cheer'`),
    events: await n('SELECT count(*)::int AS n FROM game_events'),
    rules: await n(`SELECT count(*)::int AS n FROM games WHERE (rules->>'periodLengthMs')::int = ${seasonConfig.PERIOD_LENGTH_MS} AND (rules->>'periods')::int = ${seasonConfig.PERIODS} AND duration_min = ${seasonConfig.GAME_MINUTES}`),
  };
  const want = {
    teams: plan.teams.length, games: plan.games.length, squads: plan.cheerSquads.length, slots: plan.cheerSlots.length,
    ball: plan.basketballSlots.length, cheer: plan.cheerPracticeSlots.length, events: 0, rules: plan.games.length,
  };
  for (const k of Object.keys(want) as (keyof typeof want)[]) {
    if (got[k] !== want[k]) throw new SeasonImportError(`import count ${k} is ${got[k]}, expected ${want[k]}`);
  }
}

/** Normalized rows (no ids, no timestamps) so two imports can be compared. */
export async function seasonSnapshot(q: { query: Q['query'] }) {
  const teams = (await q.query(`SELECT name, grade, gender, coach, grade_order, logo_url FROM teams ORDER BY grade_order, gender NULLS FIRST, lower(name), name`)).rows;
  const games = (await q.query(`SELECT to_char(g.scheduled_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS date,
      to_char(g.scheduled_at AT TIME ZONE 'America/Chicago', 'HH24:MI') AS time,
      c.slug AS court, h.name AS home, a.name AS away, g.division, g.duration_min,
      (g.rules->>'periods')::int AS periods, (g.rules->>'periodLengthMs')::int AS period_length_ms
    FROM games g
    JOIN courts c ON c.id = g.court_id
    JOIN teams h ON h.id = g.home_team_id
    JOIN teams a ON a.id = g.away_team_id
    ORDER BY 1, 2, 3, 4, 5`)).rows;
  const squads = (await q.query(`SELECT name, coach, logo_url FROM cheer_squads ORDER BY lower(name)`)).rows;
  const slots = (await q.query(`SELECT to_char(s.date, 'YYYY-MM-DD') AS date, to_char(s.slot_start, 'HH24:MI') AS start, q.name AS squad
    FROM cheer_slots s JOIN cheer_squads q ON q.id = s.squad_id ORDER BY 1, 2, 3`)).rows;
  const days = (await q.query(`SELECT day_of_week AS day, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS "end" FROM practice_days ORDER BY 1`)).rows;
  const practice = (await q.query(`SELECT p.kind, p.day_of_week AS day, to_char(p.start_time,'HH24:MI') AS start, p.court, p.room, t.name AS team, q.name AS squad
    FROM practice_slots p
    LEFT JOIN teams t ON t.id = p.team_id
    LEFT JOIN cheer_squads q ON q.id = p.squad_id
    ORDER BY p.kind, p.day_of_week, p.start_time NULLS LAST, p.court NULLS LAST, p.room NULLS LAST, t.name NULLS LAST, q.name NULLS LAST`)).rows;
  return { teams, games, squads, slots, days, practice };
}

export async function seedSeason(opts: SeedSeasonOptions = {}): Promise<SeedSeasonResult> {
  await migrate();
  const plan = buildSeasonPlan(readSeasonCsvs(opts.files ?? defaultSeasonFiles()));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await loadExisting(client);
    const decision = replacementDecision(existing, plan.games);
    if (opts.ifNeeded && decision.kind === 'season' && existing.length === plan.games.length) {
      await client.query('ROLLBACK');
      return { report: `${formatSeasonReport(plan)}\nSKIPPED: 2027 season already loaded. Nothing changed.`, committed: false, skipped: true, plan };
    }
    if (!opts.dryRun && !opts.reset && !decision.ok) {
      await client.query('ROLLBACK');
      throw new SeasonRefusedError(decision.reason || 'Refusing to replace existing games. Re-run with --reset.');
    }
    await ensureCourts(client);
    await clearSeason(client);
    if (opts.injectError) throw new SeasonImportError(opts.injectError);
    await applyPlan(client, plan);
    await assertCounts(client, plan);
    // Marker (not a color setting): startup SEED=demo/true must never replace a loaded real season.
    await client.query(`INSERT INTO settings(key, value) VALUES ('season_data', '2027') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    if (opts.dryRun) {
      await client.query('ROLLBACK');
      return { report: `${formatSeasonReport(plan)}\nDRY RUN: rolled back, nothing written.`, committed: false, skipped: false, plan };
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  let logos = '';
  try { logos = formatReport(await loadLogos(pool)); }
  catch (e) { logos = `logo load failed (${e instanceof Error ? e.message : e}); import kept`; }
  return { report: `${formatSeasonReport(plan)}\nIMPORTED\n${logos}`, committed: true, skipped: false, plan, logos };
}

export { gameNaturalKey };

const invoked = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  const args = process.argv.slice(2);
  const known = new Set(['--dry-run', '--reset']);
  const bad = args.filter((a) => !known.has(a));
  if (bad.length) {
    console.error(`Unknown option(s): ${bad.join(' ')}\nUsage: node dist/src/seed-season.js [--dry-run] [--reset]`);
    process.exit(2);
  }
  try {
    const result = await seedSeason({ dryRun: args.includes('--dry-run'), reset: args.includes('--reset') });
    console.log(result.report);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
