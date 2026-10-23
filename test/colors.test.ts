// Colors (Aaron, c5882fa: "the team color picker doesn't save correctly"): hex in, uppercase #RRGGBB stored, bad = 400,
// old rgb()/lowercase values migrated at startup. Unit tests always run; DB/API part needs TEST_DATABASE_URL (own DB *_colors).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ChildProcess } from 'node:child_process';
import { normHex, toHexLoose } from '../src/color.js';
import { startServer } from './_server.js';

test('normHex: #RGB / #RRGGBB any case -> uppercase #RRGGBB; everything else null', () => {
  assert.equal(normHex('#1e90ff'), '#1E90FF');
  assert.equal(normHex(' #1E90Ff '), '#1E90FF');
  assert.equal(normHex('#f0a'), '#FF00AA');
  assert.equal(normHex('#FFF'), '#FFFFFF');
  for (const bad of ['1e90ff', '#1e90f', '#1e90ffa', '#ggg', 'rgb(30,144,255)', 'blue', '', null, undefined, 12]) assert.equal(normHex(bad), null, String(bad));
});
test('toHexLoose (migration only): also rgb()/rgba() and a missing #', () => {
  assert.equal(toHexLoose('rgb(30, 144, 255)'), '#1E90FF');
  assert.equal(toHexLoose('RGBA(255,0,0,0.5)'), '#FF0000');
  assert.equal(toHexLoose('rgb(0 128 0 / 50%)'), '#008000');
  assert.equal(toHexLoose('7a1020'), '#7A1020');
  assert.equal(toHexLoose('rgb(300,0,0)'), null);
  assert.equal(toHexLoose('blue'), null);
});

const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test"' : false;
let db: typeof import('../src/db.js'); let srv: ChildProcess | null = null; let URL_ = '', BASE = '', token = '';
const ADMIN = 'colors-admin-pw';
const api = async (p: string, method = 'GET', body?: unknown) => {
  const r = await fetch(BASE + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let b: any; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b };
};
before(async () => {
  if (skip) return;
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_colors'; u.pathname = '/' + name; URL_ = u.toString();
  const a = new pg.Client({ connectionString: BASE_URL }); await a.connect();
  if (!(await a.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await a.query(`CREATE DATABASE "${name}"`);
  await a.end();
  process.env.DATABASE_URL = URL_; process.env.TZ = 'America/Chicago';
  db = await import('../src/db.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
after(async () => { srv?.kill(); await db?.pool.end(); });

test('DB: startup migration converts rgb()/lowercase season colors, idempotent; retired team + game colors untouched', { skip }, async () => {
  const { pool } = db;
  await db.migrate();
  await pool.query(`INSERT INTO courts(slug, name) VALUES ('full','Full') ON CONFLICT DO NOTHING`);
  const team = async (n: string, p: string, s: string) => (await pool.query(`INSERT INTO teams(name, grade, grade_order, gender, primary_color, secondary_color) VALUES ($1,'5th Grade',5,'Boys',$2,$3) RETURNING id`, [n, p, s])).rows[0].id;
  const A = await team('Hawks', 'rgb(30, 144, 255)', '#fff'), B = await team('Owls', '#7a1020', 'not-a-color');
  await pool.query(`INSERT INTO settings(key,value) VALUES ('season_dark','rgb(128,0,0)'),('season_light','#ffc72c') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
  const g = (await pool.query(`INSERT INTO games(court_id, scheduled_at, home_team_id, away_team_id, status, theme) VALUES ((SELECT id FROM courts WHERE slug='full'), now(), $1, $2, 'active', $3) RETURNING id`,
    [A, B, { homeName: 'H', homeColor: 'rgb(0,128,0)', awayColor: '#abc', awayAccent: 'RGBA(255,255,255,1)' }])).rows[0].id;
  await pool.query(`UPDATE courts SET current_game_id=$1 WHERE slug='full'`, [g]);
  const g2 = (await pool.query(`INSERT INTO games(court_id, scheduled_at, home_team_id, away_team_id, theme) VALUES ((SELECT id FROM courts WHERE slug='full'), now() + interval '1 day', $1, $2, '{}') RETURNING id`, [A, B])).rows[0].id;
  const n1 = await db.migrateColors();
  assert.equal(n1, 2, `only the two season settings converted (${n1})`);
  const t = (await pool.query('SELECT name, primary_color p, secondary_color s FROM teams ORDER BY id')).rows;
  assert.deepEqual(t.map((r: any) => [r.p, r.s]), [['rgb(30, 144, 255)', '#fff'], ['#7a1020', 'not-a-color']], 'team colors are retired: data left exactly as it was');
  const st = Object.fromEntries((await pool.query(`SELECT key, value FROM settings WHERE key LIKE 'season_%'`)).rows.map((r: any) => [r.key, r.value]));
  assert.equal(st.season_dark, '#800000'); assert.equal(st.season_light, '#FFC72C');
  const gr = (await pool.query('SELECT status, theme FROM games WHERE id=$1', [g])).rows[0];
  assert.deepEqual(gr.theme, { homeName: 'H', homeColor: 'rgb(0,128,0)', awayColor: '#abc', awayAccent: 'RGBA(255,255,255,1)' }, 'retired per-game colors: data left exactly as it was');
  assert.equal(gr.status, 'active', 'live game untouched');
  assert.deepEqual((await pool.query('SELECT theme FROM games WHERE id=$1', [g2])).rows[0].theme, {});
  assert.equal(await db.migrateColors(), 0, 'second run changes nothing');
  await db.migrate(); assert.equal(await db.migrateColors(), 0);
});

test('API: season hex (#RGB / #RRGGBB) stored uppercase, bad = 400; game colors ignored with a note, TV shows season colors', { skip }, async () => {
  const started = await startServer({ DATABASE_URL: URL_, ADMIN_PASSWORD: ADMIN, TZ: 'America/Chicago', SEED: '' });
  srv = started.srv; BASE = `http://127.0.0.1:${started.port}`;
  token = (await api('/api/login', 'POST', { password: ADMIN })).body.token; assert.ok(token);
  // Season colors
  let r = await api('/api/settings/season', 'PUT', { name: 'S', dark: '#036', light: '#ffc72c' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([(await api('/api/settings/season')).body.dark, (await api('/api/settings/season')).body.light], ['#003366', '#FFC72C']);
  r = await api('/api/settings/season', 'PUT', { name: 'S', dark: 'rgb(0,0,0)', light: '#ffc72c' });
  assert.equal(r.status, 400); assert.match(r.body.error, /dark "rgb\(0,0,0\)" is not a color; use hex like #1E90FF \(#RGB or #RRGGBB\)/);
  // Per-game colors are retired (Aaron): ignored on input with a note, never returned, displays use the season colors
  const gid = (await db.pool.query(`SELECT id FROM games WHERE status='active'`)).rows[0].id;
  const stored0 = (await db.pool.query('SELECT theme FROM games WHERE id=$1', [gid])).rows[0].theme;
  const cur = (await api('/api/games')).body.find((x: any) => x.id === gid);
  for (const k of ['homeColor', 'awayColor', 'homeAccent', 'awayAccent']) assert.ok(!(k in (cur.theme || {})), `GET /api/games has no theme.${k}`);
  const put = (theme: any) => api(`/api/games/${gid}`, 'PUT', { court_id: cur.court_id, home_team_id: cur.home_team_id, away_team_id: cur.away_team_id, scheduled_at: null, division: cur.division ?? '', theme, swap_colors: false });
  for (const th of [{ homeColor: '#1e90ff', awayColor: '#F0a' }, { homeColor: 'rgb(30,144,255)' }, { homeColor: 'blue', awayAccent: '#12345' }]) {
    r = await put({ homeName: 'HN', ...th });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.warnings.join(' '), /game colors ignored: every game uses the season colors/);
  }
  const saved = (await db.pool.query('SELECT theme FROM games WHERE id=$1', [gid])).rows[0].theme;
  assert.equal(saved.homeName, 'HN', 'display name still saved');
  for (const k of ['homeColor', 'awayColor', 'homeAccent', 'awayAccent']) assert.equal(saved[k], stored0[k], `stored theme.${k} untouched`);
  r = await put({ homeName: 'HN' }); assert.ok(!r.body.warnings.some((w: string) => /game colors ignored/.test(w)), 'no note without colors');
  let tv = await (await fetch(`${BASE}/api/public/court/full`)).json();
  assert.equal(tv.game.home.color, '#FFC72C', 'TV: home = season light'); assert.equal(tv.game.away.color, '#003366', 'TV: away = season dark');
  assert.ok(!JSON.stringify(tv).includes('rgb(0,128,0)') && !/homeColor|awayColor/.test(JSON.stringify(tv)), 'TV snapshot carries no game colors');
  r = await api(`/api/games/${gid}`, 'PUT', { swap_colors: true }); assert.equal(r.status, 200, JSON.stringify(r.body));
  tv = await (await fetch(`${BASE}/api/public/court/full`)).json();
  assert.equal(tv.game.home.color, '#003366', 'Swap: home = season dark'); assert.equal(tv.game.away.color, '#FFC72C', 'Swap: away = season light');
  await api(`/api/games/${gid}`, 'PUT', { swap_colors: false });
  // schedule.csv: color columns ignored with a note, never exported
  { const csv = `id,home_color,away_color\n${gid},#123456,#654321\n`;
    const ir = await (await fetch(`${BASE}/api/import/schedule.csv`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/csv' }, body: csv })).json();
    assert.deepEqual(ir.errors, [], JSON.stringify(ir)); assert.match((ir.warnings || []).join(' '), /home_color, away_color game colors ignored/);
    const th = (await db.pool.query('SELECT theme FROM games WHERE id=$1', [gid])).rows[0].theme;
    for (const k of ['homeColor', 'awayColor']) assert.equal(th[k], stored0[k], `import left theme.${k} untouched`); }
  const exp = await (await fetch(`${BASE}/api/export/schedule.csv`, { headers: { authorization: `Bearer ${token}` } })).text();
  assert.ok(!/color(?!s)|accent|theme/i.test(exp.split('\n')[0].replace('swap_colors', '')), `export header has no game colors: ${exp.split('\n')[0]}`);
  // Team colors (Aaron: season colors only): not exported, ignored on input with a note, DB data untouched
  const tm = (await api('/api/teams')).body[0];
  assert.ok(!('primary_color' in tm) && !('secondary_color' in tm), 'GET /api/teams has no team colors');
  const before = (await db.pool.query('SELECT primary_color p, secondary_color s FROM teams WHERE id=$1', [tm.id])).rows[0];
  for (const pc of ['rgb(1,2,3)', '#abc']) {
    r = await api(`/api/teams/${tm.id}`, 'PUT', { ...tm, primary_color: pc, secondary_color: '#ddeeff' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.warnings[0], /ignored: every team uses the season colors/);
  }
  assert.deepEqual((await db.pool.query('SELECT primary_color p, secondary_color s FROM teams WHERE id=$1', [tm.id])).rows[0], before, 'stored team colors untouched');
  r = await api('/api/teams', 'POST', { name: 'NoColor', grade: '5th Grade', gender: 'Boys', primary_color: '#123456' });
  assert.equal(r.status, 201); assert.match(r.body.warnings[0], /ignored/);
  assert.equal((await db.pool.query('SELECT primary_color p FROM teams WHERE id=$1', [r.body.id])).rows[0].p, '#333333', 'column default, not the sent color');
  const imp = await fetch(`${BASE}/api/import/teams.csv`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/csv' }, body: 'name,grade,gender,primary_color,secondary_color\nCsvTeam,5th Grade,Boys,#ff0000,bogus\n' }).then((x) => x.json());
  assert.equal(imp.created, 1); assert.deepEqual(imp.errors, []);
  assert.match(imp.warnings[0], /primary_color and secondary_color ignored: every team uses the season colors/);
  const csvOut = await fetch(`${BASE}/api/export/teams.csv`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.text());
  assert.doesNotMatch(csvOut.split('\n')[0], /color/, 'teams.csv export has no color columns');
  const games = (await api('/api/games')).body;
  assert.ok(games.length && games.every((g: any) => !Object.keys(g).some((k) => /primary|secondary/.test(k))), 'game rows carry no team colors');
});

test('season colors reach every screen: public season API, inline season-vars in HTML, season WS role, revalidated assets', async () => {
  await api('/api/settings/season', 'PUT', { name: 'Spring', dark: '#4e7afd', light: '#ffc72c' });
  const pub = await fetch(`${BASE}/api/public/season`).then((x) => x.json());
  assert.equal(pub.dark, '#4E7AFD'); assert.equal(pub.light, '#FFC72C');
  for (const p of ['/upwardbasketballscores/lobby', '/practice/basketball', '/practice/cheer', '/admin']) {
    const r = await fetch(BASE + p); const html = await r.text();
    assert.match(html, /<style id="season-vars">:root\{--season-light:#FFC72C;--season-dark:#4E7AFD;/, p);
    assert.match(html, /<script src="\/season\.js"><\/script>/, p);
    assert.match(r.headers.get('cache-control') || '', /no-cache, must-revalidate/, p);
    const et = r.headers.get('etag')!; assert.ok(et, p);
    assert.equal((await fetch(BASE + p, { headers: { 'if-none-match': et } })).status, 304, p);
  }
  const css = await fetch(`${BASE}/lobby.css`); assert.match(css.headers.get('cache-control') || '', /no-cache/); assert.ok(css.headers.get('etag'));
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?court=*&role=season');
  const msgs: any[] = []; ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
  const until = async (f: () => boolean) => { for (let i = 0; i < 50 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); };
  await until(() => msgs.some((m) => m.kind === 'season'));
  assert.equal(msgs.find((m) => m.kind === 'season').season.dark, '#4E7AFD');
  await api('/api/settings/season', 'PUT', { name: 'Spring', dark: '#224466', light: '#ffdd88' });
  await until(() => msgs.some((m) => m.kind === 'season' && m.season.dark === '#224466'));
  assert.ok(msgs.some((m) => m.kind === 'season' && m.season.light === '#FFDD88'), 'season push arrives live');
  ws.close();
});
