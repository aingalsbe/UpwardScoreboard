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

test('test clock: needs SCOREBOARD_TEST_CLOCK=1 + SCOREBOARD_TEST_NOW; refused for any production-like NODE_ENV', async () => {
  const srv = path.join(ROOT, 'dist/src/server.js'), NOW = '2026-10-30T15:00:00Z', DB = 'postgres://nobody@127.0.0.1:1/x';
  const base = { ...process.env }; delete base.SCOREBOARD_TEST_CLOCK; delete base.SCOREBOARD_TEST_NOW;
  const run = (env: Record<string, string>) => spawnSync(process.execPath, [srv], { env: { ...base, DATABASE_URL: DB, ...env }, encoding: 'utf8', timeout: 10_000 });
  for (const ne of ['production', 'Production', 'PRODUCTION', 'prod', ' production ']) {
    const r = run({ NODE_ENV: ne, SCOREBOARD_TEST_CLOCK: '1', SCOREBOARD_TEST_NOW: NOW });
    assert.equal(r.status, 1, ne); assert.match(r.stderr, /test-only setting and must not be set in production.*Refusing to start/, ne);
  }
  const noFlag = run({ NODE_ENV: 'test', SCOREBOARD_TEST_NOW: NOW });
  assert.equal(noFlag.status, 1); assert.match(noFlag.stderr, /needs the explicit opt-in SCOREBOARD_TEST_CLOCK=1/);
  const flag0 = run({ NODE_ENV: 'development', SCOREBOARD_TEST_CLOCK: 'true', SCOREBOARD_TEST_NOW: NOW });
  assert.equal(flag0.status, 1, 'only exactly 1 opts in');
  const noNow = run({ NODE_ENV: 'test', SCOREBOARD_TEST_CLOCK: '1' });
  assert.equal(noNow.status, 1); assert.match(noNow.stderr, /needs SCOREBOARD_TEST_NOW/);
  const bad = run({ NODE_ENV: 'test', SCOREBOARD_TEST_CLOCK: '1', SCOREBOARD_TEST_NOW: 'soon' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /is not a date\/time/);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `process.env.SCOREBOARD_TEST_CLOCK='1'; process.env.SCOREBOARD_TEST_NOW='${NOW}'; await import(${JSON.stringify(path.join(ROOT, 'dist/src/test-clock.js'))}); console.log(Date.now())`], { env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8' });
  assert.ok(Math.abs(Number(r.stdout.trim()) - Date.parse(NOW)) < 5000, r.stdout + r.stderr);
  assert.match(r.stderr, /TEST CLOCK: time shifted/);
  assert.match(fs.readFileSync(path.join(ROOT, 'dist/src/server.js'), 'utf8').split('\n').find((l) => l.startsWith('import'))!, /test-clock\.js/, 'test-clock is the first import');
});

test('admin game form shows every rule reason; import help states the Fri/Sat 8 AM–9 PM rule', { skip: !fs.existsSync(path.join(ROOT, 'public/admin.js')) && 'public/ not present' }, () => {
  const js = fs.readFileSync(path.join(ROOT, 'public/admin.js'), 'utf8');
  assert.match(js, /const errText = \(e\) =>[^\n]*e\.body\?\.errors/); assert.match(js, /msg\(errText\(e\), true\)/);
  const html = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
  assert.match(html, /Friday or Saturday with tip-off 8 AM–9 PM/);
  assert.match(html, /status=complete marks a row as a final<\/strong>[^<]*exempt from the game-hours rule and import with a warning only/);
});
