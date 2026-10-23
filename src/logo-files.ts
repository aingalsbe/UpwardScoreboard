// Mascot logos (Sage, 2026-10): PNGs in deliverables/logos/{teams,cheer}/ + manifest.json, served read-only at
// /team-logos/<teams|cheer>/<file>.png. The DB stores only the path in teams.logo_url / cheer_squads.logo_url
// (an uploaded logo_data still wins). loadLogos() fills empty logos from the manifest; idempotent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const LOGO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deliverables/logos');
export const LOGO_ROUTE = '/team-logos/';
export const LOGO_MAX_BYTES = 300 * 1024;

export interface Manifest { teams: { name: string; division: string; file: string }[]; cheer: { name: string; file: string }[] }
export const readManifest = (dir = LOGO_DIR): Manifest => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
/** Case/space-insensitive key: "  5th grade   BOYS " -> "5th grade boys". */
export const norm = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
export const logoUrl = (file: string) => LOGO_ROUTE + file.replace(/^\/+/, '');

/** Resolve a /team-logos/... request to a PNG file in teams/ or cheer/ (null = 404). */
export function logoFile(pathname: string, dir = LOGO_DIR): string | null {
  const m = /^\/team-logos\/(teams|cheer)\/([a-z0-9][a-z0-9-]*\.png)$/.exec(pathname);
  if (!m) return null;
  const full = path.join(dir, m[1], m[2]);
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
}

export interface LoadReport { dryRun: boolean; overwrite: boolean;
  teams: { matched: number; filled: number; skipped: number; unmatched: string[]; withoutLogo: string[] };
  squads: { matched: number; filled: number; skipped: number; unmatched: string[]; withoutLogo: string[] } }

/** Fill teams/cheer_squads logos from the manifest. Teams match on name + division ("<grade> <gender>"), squads on
 *  name. Default fills only rows with no logo_url and no uploaded logo_data; overwrite replaces both. */
export async function loadLogos(db: pg.Pool | pg.PoolClient, opts: { dryRun?: boolean; overwrite?: boolean; dir?: string } = {}): Promise<LoadReport> {
  const man = readManifest(opts.dir), dryRun = !!opts.dryRun, overwrite = !!opts.overwrite;
  const rep: LoadReport = { dryRun, overwrite, teams: { matched: 0, filled: 0, skipped: 0, unmatched: [], withoutLogo: [] }, squads: { matched: 0, filled: 0, skipped: 0, unmatched: [], withoutLogo: [] } };
  const run = async (kind: 'teams' | 'squads', rows: any[], key: (r: any) => string, entries: { k: string; label: string; file: string }[], table: string) => {
    const r = rep[kind], byKey = new Map(entries.map((e) => [e.k, e]));
    const seen = new Set<string>();
    for (const row of rows) {
      const e = byKey.get(key(row));
      if (!e) { r.withoutLogo.push(row.label); continue; }
      seen.add(e.k); r.matched++;
      const empty = !row.logo_url && !row.has_data;
      if (!empty && !overwrite) { r.skipped++; continue; }
      if (!dryRun) await db.query(`UPDATE ${table} SET logo_url=$2, logo_data=NULL, logo_mime=NULL WHERE id=$1`, [row.id, logoUrl(e.file)]);
      r.filled++;
    }
    r.unmatched = entries.filter((e) => !seen.has(e.k)).map((e) => e.label);
  };
  const teams = (await db.query(`SELECT id, name, grade, gender, logo_url, (logo_data IS NOT NULL) has_data, concat_ws(' · ', name, concat_ws(' ', grade, gender)) label FROM teams ORDER BY id`)).rows;
  await run('teams', teams, (t) => norm(t.name) + '|' + norm(`${t.grade ?? ''} ${t.gender ?? ''}`),
    man.teams.map((t) => ({ k: norm(t.name) + '|' + norm(t.division), label: `${t.name} · ${t.division}`, file: t.file })), 'teams');
  const squads = (await db.query(`SELECT id, name, name label, logo_url, (logo_data IS NOT NULL) has_data FROM cheer_squads ORDER BY id`)).rows;
  await run('squads', squads, (s) => norm(s.name), man.cheer.map((c) => ({ k: norm(c.name), label: c.name, file: c.file })), 'cheer_squads');
  return rep;
}

export function formatReport(r: LoadReport): string {
  const line = (n: string, x: LoadReport['teams']) => `${n}: matched ${x.matched}, filled ${x.filled}${r.dryRun ? ' (dry run, nothing written)' : ''}, skipped ${x.skipped} (already set)` +
    `, unmatched manifest entries ${x.unmatched.length}${x.unmatched.length ? ' [' + x.unmatched.join('; ') + ']' : ''}` +
    `, rows with no manifest logo ${x.withoutLogo.length}${x.withoutLogo.length ? ' [' + x.withoutLogo.join('; ') + ']' : ''}`;
  return `${r.dryRun ? 'DRY RUN' : 'LOADED'}${r.overwrite ? ' (overwrite)' : ''}\n${line('teams', r.teams)}\n${line('cheer squads', r.squads)}`;
}
