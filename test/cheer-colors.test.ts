// Cheer season colors (Morgan): uppercase #RRGGBB rows, copied once from the season pair, optional on PUT,
// injected into every page, and contrasted like the home/away colors. Unit tests always run; the DB/API
// part needs TEST_DATABASE_URL (its own database whose name contains "test").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ChildProcess } from 'node:child_process';
import { fgFor, onDarkFor, lumHex, seasonCss } from '../src/color.js';
import { startServer } from './_server.js';

const COLORS = ['#FFFFFF', '#000000', '#777777', '#FF00AA', '#00CCDD', '#FFC72C', '#800000'];
const ratio = (a: string, b: string) => { const x = lumHex(a), y = lumHex(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('fgFor / onDarkFor stay >= 4.5:1 on the cheer color and on black', () => {
  for (const h of COLORS) {
    assert.ok(ratio(fgFor(h), h) >= 4.5, `${h} fg ${fgFor(h)} ${ratio(fgFor(h), h)}`);
    assert.ok(ratio(onDarkFor(h), '#000000') >= 4.5, `${h} on dark ${onDarkFor(h)} ${ratio(onDarkFor(h), '#000000')}`);
  }
});

test('seasonCss keeps the legacy six vars first, then the six cheer vars; bad hex is #808080', () => {
  const css = seasonCss({ light: '#FFFFFF', dark: '#000000', cheerPrimary: '#FF00AA', cheerSecondary: '#00CCDD' });
  assert.ok(css.startsWith('<style id="season-vars">:root{--season-light:#FFFFFF;--season-dark:#000000;--season-light-fg:#000000;--season-dark-fg:#FFFFFF;--season-light-on-dark:#FFFFFF;--season-dark-on-dark:#FFFFFF;--season-cheer-primary:#FF00AA;'), css);
  const keys = [...css.matchAll(/(--[\w-]+):/g)].map((m) => m[1]);
  assert.deepEqual(keys, [
    '--season-light', '--season-dark', '--season-light-fg', '--season-dark-fg', '--season-light-on-dark', '--season-dark-on-dark',
    '--season-cheer-primary', '--season-cheer-secondary', '--season-cheer-primary-fg', '--season-cheer-secondary-fg', '--season-cheer-primary-on-dark', '--season-cheer-secondary-on-dark',
  ]);
  const bad = seasonCss({ light: 'blue', dark: '#12', cheerPrimary: '#xyzxyz', cheerSecondary: '' });
  assert.equal(bad, seasonCss({ light: '#808080', dark: '#808080', cheerPrimary: '#808080', cheerSecondary: '#808080' }));
  for (const h of COLORS) {
    const one = seasonCss({ light: '#FFFFFF', dark: '#000000', cheerPrimary: h, cheerSecondary: h });
    const v = Object.fromEntries([...one.matchAll(/(--[\w-]+):(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2].toUpperCase()]));
    assert.ok(ratio(v['--season-cheer-primary-fg'], h) >= 4.5, h);
    assert.ok(ratio(v['--season-cheer-primary-on-dark'], '#000000') >= 4.5, h);
    assert.ok(ratio(v['--season-cheer-secondary-fg'], h) >= 4.5, h);
    assert.ok(ratio(v['--season-cheer-secondary-on-dark'], '#000000') >= 4.5, h);
  }
});

test('season.js: cheer-only change reapplies, missing/invalid cheer falls back, contrast holds (AC7, AC13)', () => {
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/season.js'), 'utf8');
  const props = new Map<string, string>();
  let sets = 0;
  const events: any[] = [];
  const sandbox: any = {
    document: { documentElement: { style: { setProperty: (k: string, v: string) => { props.set(k, v); sets++; } }, dataset: {} }, addEventListener() {}, hidden: false },
    location: { protocol: 'http:', host: 'localhost' },
    WebSocket: class { readyState = 0; send() {} close() {} },
    CustomEvent: class { type: string; detail: any; constructor(type: string, init?: { detail?: any }) { this.type = type; this.detail = init?.detail; } },
    setTimeout: () => 0,
  };
  sandbox.window = sandbox;
  sandbox.dispatchEvent = (e: any) => { events.push(e); };
  vm.createContext(sandbox);
  sandbox.setTimeout = () => 0; // the contextified global otherwise keeps the real timer and the socket retry never stops
  vm.runInContext(src, sandbox, { filename: 'season.js' });
  const apply = sandbox.Season.apply as (s: any) => void;
  apply({ name: 'N', light: '#FFC72C', dark: '#800000' });
  assert.equal(props.get('--season-cheer-primary'), '#FFC72C', 'missing primary falls back to light');
  assert.equal(props.get('--season-cheer-secondary'), '#800000', 'missing secondary falls back to dark');
  assert.equal(events.at(-1).detail.cheerPrimary, '#FFC72C');
  assert.equal(events.at(-1).detail.cheerSecondary, '#800000');
  const frozen = sets;
  apply({ name: 'N', light: '#FFC72C', dark: '#800000', cheerPrimary: 'blue', cheerSecondary: 'nope' });
  assert.equal(sets, frozen, 'invalid cheer resolves to the same fallback and does not reapply');
  apply({ name: 'N', light: '#ffc72c', dark: '#800000', cheerPrimary: '#00ccdd', cheerSecondary: '#800000' });
  assert.ok(sets > frozen, 'a cheer-only change reapplies');
  assert.equal(props.get('--season-cheer-primary'), '#00CCDD');
  assert.equal(props.get('--season-cheer-secondary'), '#800000');
  assert.equal(sandbox.document.documentElement.dataset.seasonCheerPrimary, '#00CCDD');
  assert.equal(sandbox.document.documentElement.dataset.seasonCheerSecondary, '#800000');
  assert.equal(events.at(-1).detail.cheerPrimary, '#00CCDD');
  for (const h of COLORS) {
    apply({ name: 'N', light: '#FFFFFF', dark: '#000000', cheerPrimary: h, cheerSecondary: h });
    assert.ok(ratio(props.get('--season-cheer-primary-fg')!, h) >= 4.5, `js fg ${h}`);
    assert.ok(ratio(props.get('--season-cheer-primary-on-dark')!, '#000000') >= 4.5, `js on-dark ${h}`);
    assert.ok(ratio(props.get('--season-cheer-secondary-fg')!, h) >= 4.5, `js fg2 ${h}`);
    assert.ok(ratio(props.get('--season-cheer-secondary-on-dark')!, '#000000') >= 4.5, `js on-dark2 ${h}`);
  }
});

const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test"' : false;
let db: typeof import('../src/db.js'); let srv: ChildProcess | null = null; let URL_ = '', BASE = '', token = '';
const ADMIN = 'cheer-colors-admin-pw';
const api = async (p: string, method = 'GET', body?: unknown) => {
  const r = await fetch(BASE + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let b: any; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b };
};
const settings = async () => Object.fromEntries((await db.pool.query(`SELECT key, value FROM settings WHERE key LIKE 'season_%'`)).rows.map((r: any) => [r.key, r.value]));
before(async () => {
  if (skip) return;
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_cheercolors'; u.pathname = '/' + name; URL_ = u.toString();
  const a = new pg.Client({ connectionString: BASE_URL }); await a.connect();
  if (!(await a.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await a.query(`CREATE DATABASE "${name}"`);
  await a.end();
  process.env.DATABASE_URL = URL_; process.env.TZ = 'America/Chicago';
  db = await import('../src/db.js');
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
after(async () => { srv?.kill(); await db?.pool.end(); });

test('AC1 migration copies season light/dark into cheer rows once and never overwrites', { skip }, async () => {
  await db.migrate();
  await db.pool.query(`INSERT INTO settings(key, value) VALUES ('season_light','#ffc72c'),('season_dark','rgb(128,0,0)') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
  await db.pool.query(`DELETE FROM settings WHERE key IN ('season_cheer_primary','season_cheer_secondary')`);
  await db.migrate(); // canonicalises the season pair, then copies it
  let s = await settings();
  assert.equal(s.season_light, '#FFC72C'); assert.equal(s.season_dark, '#800000');
  assert.equal(s.season_cheer_primary, '#FFC72C'); assert.equal(s.season_cheer_secondary, '#800000');
  assert.equal(await db.migrateCheerColors(), 0, 'second run inserts nothing');
  s = await settings();
  assert.equal(s.season_cheer_primary, '#FFC72C'); assert.equal(s.season_cheer_secondary, '#800000');
  await db.pool.query(`UPDATE settings SET value='#FF00AA' WHERE key='season_cheer_primary'`);
  await db.pool.query(`UPDATE settings SET value='#00CCDD' WHERE key='season_cheer_secondary'`);
  await db.migrate();
  s = await settings();
  assert.equal(s.season_cheer_primary, '#FF00AA', 'admin primary kept');
  assert.equal(s.season_cheer_secondary, '#00CCDD', 'admin secondary kept');
});

test('AC2 migrateColors canonicalises legacy cheer hex and rgb()', { skip }, async () => {
  await db.pool.query(`UPDATE settings SET value='#ff00aa' WHERE key='season_cheer_primary'`);
  await db.pool.query(`UPDATE settings SET value='rgb(0,128,0)' WHERE key='season_cheer_secondary'`);
  const n = await db.migrateColors();
  assert.ok(n >= 2, `converted cheer rows (${n})`);
  const s = await settings();
  assert.equal(s.season_cheer_primary, '#FF00AA'); assert.equal(s.season_cheer_secondary, '#008000');
  assert.equal(await db.migrateColors(), 0);
});

test('AC3 AC4 AC6 AC8 AC13 season API, HTML vars, live socket, absent-row startup', { skip }, async () => {
  const boot = async () => {
    const started = await startServer({ DATABASE_URL: URL_, ADMIN_PASSWORD: ADMIN, TZ: 'America/Chicago', SEED: '' });
    srv = started.srv; BASE = `http://127.0.0.1:${started.port}`;
    token = (await api('/api/login', 'POST', { password: ADMIN })).body.token; assert.ok(token);
  };
  await boot();
  let r = await api('/api/settings/season', 'PUT', { name: 'Cheer', dark: '#800000', light: '#FFC72C', cheerPrimary: '#f0a', cheerSecondary: '#00ccdd' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cheerPrimary, '#FF00AA'); assert.equal(r.body.cheerSecondary, '#00CCDD');
  assert.equal(r.body.dark, '#800000'); assert.equal(r.body.light, '#FFC72C');
  const pub = await (await fetch(`${BASE}/api/public/season`)).json();
  const admin = (await api('/api/settings/season')).body;
  for (const body of [pub, admin]) {
    assert.equal(body.cheerPrimary, '#FF00AA'); assert.equal(body.cheerSecondary, '#00CCDD');
    assert.match(body.cheerPrimary, /^#[0-9A-F]{6}$/); assert.match(body.cheerSecondary, /^#[0-9A-F]{6}$/);
  }
  const before = (await api('/api/settings/season')).body;
  r = await api('/api/settings/season', 'PUT', { name: 'Nope', dark: '#003366', light: '#FFDD88', cheerPrimary: 'blue', cheerSecondary: '#00CCDD' });
  assert.equal(r.status, 400); assert.match(r.body.error, /cheerPrimary/); assert.match(r.body.error, /#RGB or #RRGGBB/);
  r = await api('/api/settings/season', 'PUT', { name: 'Nope', dark: '#003366', light: '#FFDD88', cheerPrimary: '#FF00AA', cheerSecondary: '#12' });
  assert.equal(r.status, 400); assert.match(r.body.error, /cheerSecondary/); assert.match(r.body.error, /#RGB or #RRGGBB/);
  let now = (await api('/api/settings/season')).body;
  assert.deepEqual({ name: now.name, dark: now.dark, light: now.light, cheerPrimary: now.cheerPrimary, cheerSecondary: now.cheerSecondary },
    { name: before.name, dark: before.dark, light: before.light, cheerPrimary: before.cheerPrimary, cheerSecondary: before.cheerSecondary }, 'invalid cheer writes nothing');
  r = await api('/api/settings/season', 'PUT', { name: 'Cheer', dark: '#FFFFFF', light: '#FFDD88' });
  assert.equal(r.status, 400); assert.match(r.body.error, /darker/);
  r = await api('/api/settings/season', 'PUT', { name: 'Cheer', dark: 'rgb(0,0,0)', light: '#FFC72C' });
  assert.equal(r.status, 400); assert.match(r.body.error, /dark .*not a color/);
  now = (await api('/api/settings/season')).body;
  assert.equal(now.dark, '#800000'); assert.equal(now.light, '#FFC72C');
  r = await api('/api/settings/season', 'PUT', { name: 'Cheer', dark: '#224466', light: '#FFDD88' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.dark, '#224466'); assert.equal(r.body.light, '#FFDD88');
  assert.equal(r.body.cheerPrimary, '#FF00AA', 'omitted primary kept'); assert.equal(r.body.cheerSecondary, '#00CCDD', 'omitted secondary kept');
  r = await api('/api/settings/season', 'PUT', { name: 'Cheer', dark: '#224466', light: '#FFDD88', cheerSecondary: '#112233' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cheerPrimary, '#FF00AA', 'omitted one side kept'); assert.equal(r.body.cheerSecondary, '#112233');
  r = await api('/api/settings/season', 'PUT', { name: 'Cheer', dark: '#4E7AFD', light: '#FFC72C', cheerPrimary: '#FF00AA', cheerSecondary: '#00CCDD' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const p of ['/upwardbasketballscores/lobby', '/practice/cheer', '/practice/basketball', '/tv/full', '/admin']) {
    const html = await (await fetch(BASE + p)).text();
    assert.match(html, /<style id="season-vars">:root\{--season-light:#FFC72C;--season-dark:#4E7AFD;--season-light-fg:#[0-9A-F]{6};--season-dark-fg:#[0-9A-F]{6};--season-light-on-dark:#[0-9A-F]{6};--season-dark-on-dark:#[0-9A-F]{6};--season-cheer-primary:#FF00AA;--season-cheer-secondary:#00CCDD;/, p);
    for (const key of ['--season-cheer-primary-fg', '--season-cheer-secondary-fg', '--season-cheer-primary-on-dark', '--season-cheer-secondary-on-dark']) assert.ok(html.includes(key + ':#'), `${p} ${key}`);
    const v = Object.fromEntries([...html.match(/<style id="season-vars">:root\{([^}]*)\}/)![1].matchAll(/(--[\w-]+):(#[0-9A-F]{6})/gi)].map((m) => [m[1], m[2].toUpperCase()]));
    assert.ok(ratio(v['--season-cheer-primary-fg'], '#FF00AA') >= 4.5, p);
    assert.ok(ratio(v['--season-cheer-secondary-fg'], '#00CCDD') >= 4.5, p);
    assert.ok(ratio(v['--season-cheer-primary-on-dark'], '#000000') >= 4.5, p);
    assert.ok(ratio(v['--season-cheer-secondary-on-dark'], '#000000') >= 4.5, p);
  }
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?court=*&role=season');
  const msgs: any[] = []; ws.on('message', (m: any) => msgs.push(JSON.parse(String(m))));
  const until = async (f: () => boolean) => { for (let i = 0; i < 50 && !f(); i++) await new Promise((res) => setTimeout(res, 50)); };
  await until(() => msgs.some((m) => m.kind === 'season' && m.season.cheerPrimary === '#FF00AA'));
  assert.equal(msgs.find((m) => m.kind === 'season').season.cheerSecondary, '#00CCDD');
  await api('/api/settings/season', 'PUT', { name: 'Cheer', dark: '#4E7AFD', light: '#FFC72C', cheerPrimary: '#ABCDEF', cheerSecondary: '#123456' });
  await until(() => msgs.some((m) => m.kind === 'season' && m.season.cheerPrimary === '#ABCDEF' && m.season.cheerSecondary === '#123456'));
  assert.ok(msgs.some((m) => m.kind === 'season' && m.season.cheerPrimary === '#ABCDEF'), 'season push carries the new cheer colors');
  ws.close();
  // Absent rows at the next startup are served as the season pair (migration writes them; loadSeason would fall back the same way).
  if (srv && srv.exitCode == null) {
    const child = srv; srv = null;
    await new Promise((res) => { child.once('exit', res); child.kill(); });
  }
  await db.pool.query(`UPDATE settings SET value='#FFC72C' WHERE key='season_light'`);
  await db.pool.query(`UPDATE settings SET value='#800000' WHERE key='season_dark'`);
  await db.pool.query(`DELETE FROM settings WHERE key IN ('season_cheer_primary','season_cheer_secondary')`);
  await boot();
  const again = (await api('/api/settings/season')).body;
  const againPub = await (await fetch(`${BASE}/api/public/season`)).json();
  for (const body of [again, againPub]) {
    assert.equal(body.light, '#FFC72C'); assert.equal(body.dark, '#800000');
    assert.equal(body.cheerPrimary, body.light); assert.equal(body.cheerSecondary, body.dark);
  }
  const html = await (await fetch(`${BASE}/upwardbasketballscores/lobby`)).text();
  assert.match(html, /--season-cheer-primary:#FFC72C;--season-cheer-secondary:#800000;/);
  const stored = await settings();
  assert.equal(stored.season_cheer_primary, '#FFC72C'); assert.equal(stored.season_cheer_secondary, '#800000');
});
