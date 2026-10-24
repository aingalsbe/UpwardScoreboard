// Sage's mascot logos (deliverables/logos): manifest integrity, the fill-only-empty loader, the /team-logos/ route.
// DB part needs TEST_DATABASE_URL (name contains "test"); uses its own database "<name>_logos" (wiped).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { LOGO_DIR, LOGO_MAX_BYTES, readManifest, norm, logoFile, logoUrl } from '../src/logo-files.js';
import { safeLogoUrl } from '../src/logo.js';
import { startServer } from './_server.js';

const noFiles = !fs.existsSync(path.join(LOGO_DIR, 'manifest.json')) && 'deliverables/logos not present';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('manifest: 44 teams + 4 cheer, unique, every file a 512x512 PNG <= 300 KB', { skip: noFiles }, () => {
  const m = readManifest();
  assert.equal(m.teams.length, 44); assert.equal(m.cheer.length, 4);
  assert.equal(new Set(m.teams.map((t) => norm(`${t.name}|${t.division}`))).size, 44, 'team name + division unique');
  assert.equal(new Set(m.cheer.map((c) => norm(c.name))).size, 4);
  for (const e of [...m.teams, ...m.cheer]) {
    const f = path.join(LOGO_DIR, e.file), b = fs.readFileSync(f);
    assert.ok(b.subarray(0, 8).equals(PNG), `${e.file} is a PNG`);
    assert.ok(b.length <= LOGO_MAX_BYTES, `${e.file} ${b.length} bytes`);
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [512, 512], `${e.file} 512x512`);
    assert.equal(logoFile(logoUrl(e.file)), f, 'route resolves the manifest file');
  }
  assert.equal(norm('  5th grade   BOYS '), '5th grade boys');
  assert.equal(logoFile('/team-logos/teams/../manifest.json'), null); assert.equal(logoFile('/team-logos/contact-sheet.png'), null);
  assert.equal(safeLogoUrl('/team-logos/teams/5th-grade-boys-eagles.png'), '/team-logos/teams/5th-grade-boys-eagles.png', 'Admin save keeps a bundled path');
  assert.throws(() => safeLogoUrl('/etc/passwd'));
});

const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = noFiles || (!BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test"' : false);
let db: typeof import('../src/db.js'); let lf: typeof import('../src/logo-files.js'); let srv: ChildProcess | null = null; let URL_ = '';
let PORT = 0, BASE = ''; // PORT=0: the OS picks a free port (test/_server.ts)
before(async () => {
  if (skip) return;
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_logos'; u.pathname = '/' + name; URL_ = u.toString();
  const admin = new pg.Client({ connectionString: BASE_URL }); await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.DATABASE_URL = URL_; process.env.TZ = 'America/Chicago';
  db = await import('../src/db.js'); lf = await import('../src/logo-files.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate(); await db.seedDemo('reset');
});
after(async () => { srv?.kill(); await db?.pool.end(); });

test('loader: demo seed covers 44/44 teams + 4/4 squads; fills only empty; idempotent; dry run writes nothing', { skip }, async () => {
  const { pool } = db;
  await pool.query(`UPDATE teams SET logo_url=NULL, logo_data=NULL`); await pool.query(`UPDATE cheer_squads SET logo_url=NULL, logo_data=NULL`);
  const keep = (await pool.query(`SELECT id FROM teams ORDER BY id LIMIT 1`)).rows[0].id;
  await pool.query(`UPDATE teams SET logo_url='https://example.org/own.png' WHERE id=$1`, [keep]);
  const sq = (await pool.query(`SELECT id FROM cheer_squads ORDER BY id LIMIT 1`)).rows[0].id;
  await pool.query(`UPDATE cheer_squads SET logo_data=$2, logo_mime='image/png' WHERE id=$1`, [sq, PNG]);
  // case/space variants still match
  await pool.query(`UPDATE teams SET name='  STARS ', grade='5TH  grade' WHERE id=(SELECT id FROM teams WHERE name='Lady Stars' AND grade='5th-6th Grade' AND gender='Girls')`);

  const dry = await lf.loadLogos(pool, { dryRun: true });
  assert.deepEqual([dry.teams.matched, dry.teams.filled, dry.teams.skipped, dry.teams.unmatched.length, dry.teams.withoutLogo.length], [44, 43, 1, 0, 0]);
  assert.deepEqual([dry.squads.matched, dry.squads.filled, dry.squads.skipped, dry.squads.unmatched.length], [4, 3, 1, 0]);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM teams WHERE logo_url LIKE '/team-logos/%'`)).rows[0].n, 0, 'dry run wrote nothing');

  const r1 = await lf.loadLogos(pool);
  assert.deepEqual([r1.teams.filled, r1.teams.skipped, r1.squads.filled, r1.squads.skipped], [43, 1, 3, 1]);
  assert.equal((await pool.query(`SELECT logo_url FROM teams WHERE id=$1`, [keep])).rows[0].logo_url, 'https://example.org/own.png', 'existing URL kept');
  assert.ok((await pool.query(`SELECT logo_data FROM cheer_squads WHERE id=$1`, [sq])).rows[0].logo_data, 'uploaded logo kept');
  assert.equal((await pool.query(`SELECT logo_url FROM teams WHERE name='  STARS '`)).rows[0].logo_url, '/team-logos/teams/5th-grade-girls-stars.png');

  const r2 = await lf.loadLogos(pool);
  assert.deepEqual([r2.teams.filled, r2.teams.skipped, r2.squads.filled, r2.squads.skipped], [0, 44, 0, 4], 'second run changes nothing');

  // a team not in the manifest is reported
  await pool.query(`INSERT INTO teams(name, grade, gender) VALUES ('Zebras', '3rd Grade', 'Boys')`);
  assert.deepEqual((await lf.loadLogos(pool, { dryRun: true })).teams.withoutLogo, ['Zebras · 3rd Grade Boys']);
});

test('static route: /team-logos/... -> image/png with cache headers; bad paths 404', { skip }, async () => {
  const started = await startServer({ DATABASE_URL: URL_, ADMIN_PASSWORD: 'x-test', TZ: 'America/Chicago', SEED: '' });
  srv = started.srv; PORT = started.port; BASE = `http://127.0.0.1:${PORT}`;
  const log = started.log();
  const r = await fetch(BASE + '/team-logos/cheer/lenexa-lil-cheer.png');
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('cache-control') || '', /max-age=86400/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const b = Buffer.from(await r.arrayBuffer());
  assert.ok(b.subarray(0, 8).equals(PNG)); assert.equal(b.length, fs.statSync(path.join(LOGO_DIR, 'cheer/lenexa-lil-cheer.png')).size);
  for (const p of ['/team-logos/teams/nope.png', '/team-logos/manifest.json', '/team-logos/contact-sheet.png', '/team-logos/teams/%2e%2e%2fmanifest.json'])
    assert.equal((await fetch(BASE + p)).status, 404, p);
});
