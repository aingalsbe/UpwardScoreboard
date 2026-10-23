// Test-only clock (SCOREBOARD_TEST_NOW, src/test-clock.ts) + the shared e2e game-day helper (scripts/_gameday.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = path.join(ROOT, 'scripts/_gameday.mjs');
const noHelper = !fs.existsSync(HELPER) && 'scripts/ not present';

test('nextGameDay: the next Friday 10:00 league time from any day (CDT and CST)', { skip: noHelper }, async () => {
  const { nextGameDay, nextSaturday } = await import(HELPER);
  const at = (s: string) => nextGameDay(Date.parse(s)).toISOString();
  assert.equal(at('2026-10-25T14:00:00-05:00'), '2026-10-30T15:00:00.000Z'); // Sun -> Fri 10:00 CDT
  assert.equal(at('2026-10-27T14:00:00-05:00'), '2026-10-30T15:00:00.000Z'); // Tue
  assert.equal(at('2026-10-29T23:59:00-05:00'), '2026-10-30T15:00:00.000Z'); // Thu late
  assert.equal(at('2026-10-30T09:59:00-05:00'), '2026-10-30T15:00:00.000Z'); // Fri before 10:00 -> today
  assert.equal(at('2026-10-24T21:30:00-05:00'), '2026-10-30T15:00:00.000Z'); // late Sat
  assert.equal(at('2026-10-31T12:00:00-05:00'), '2026-11-06T16:00:00.000Z'); // across DST: Fri 10:00 CST
  assert.equal(nextSaturday('15:00', 0, Date.parse('2026-10-27T12:00:00-05:00')).toISOString(), '2026-10-31T20:00:00.000Z');
});

test('SCOREBOARD_TEST_NOW: refused in production; shifts the clock otherwise', async () => {
  const srv = path.join(ROOT, 'dist/src/server.js');
  const prod = spawnSync(process.execPath, [srv], { env: { ...process.env, NODE_ENV: 'production', SCOREBOARD_TEST_NOW: '2026-10-30T15:00:00Z', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(prod.status, 1); assert.match(prod.stderr, /test-only setting and must not be set in production; refusing to start/);
  const bad = spawnSync(process.execPath, [srv], { env: { ...process.env, NODE_ENV: 'test', SCOREBOARD_TEST_NOW: 'soon' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /is not a date\/time/);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `process.env.SCOREBOARD_TEST_NOW='2026-10-30T15:00:00Z'; await import(${JSON.stringify(path.join(ROOT, 'dist/src/test-clock.js'))}); console.log(Date.now(), new Date().toISOString())`], { env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8' });
  const [ms] = r.stdout.trim().split(' ').map(Number); assert.ok(Math.abs(ms - Date.parse('2026-10-30T15:00:00Z')) < 5000, r.stdout + r.stderr);
  assert.match(r.stderr, /TEST CLOCK: time shifted/);
  assert.match(fs.readFileSync(path.join(ROOT, 'dist/src/server.js'), 'utf8').split('\n').find((l) => l.startsWith('import'))!, /test-clock\.js/, 'test-clock is the first import');
});

test('admin game form shows every rule reason; import help states the Fri/Sat 8 AM–9 PM rule', { skip: !fs.existsSync(path.join(ROOT, 'public/admin.js')) && 'public/ not present' }, () => {
  const js = fs.readFileSync(path.join(ROOT, 'public/admin.js'), 'utf8');
  assert.match(js, /const errText = \(e\) =>[^\n]*e\.body\?\.errors/); assert.match(js, /msg\(errText\(e\), true\)/);
  const html = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
  assert.match(html, /Friday or Saturday with tip-off 8 AM–9 PM/);
});
