// Release 2: practice-night countdown clocks (pure logic + server/DB integration + persistence).
// Pure tests always run. Server + DB tests run when TEST_DATABASE_URL is set (database name must contain "test").
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { WebSocket } from 'ws';
import {
  DEVO_MS, END_MS, LAST_SLOT_CAP_MS, PRACTICE_BUZZ_MS, PRACTICE_CLOCK_KEY, STALE_BUZZ_MS,
  PracticeData, PracticeClockControl,
  applyStoredControl, computePracticeClocks, currentPractice, dueBuzzEvents, formatSlotLabel,
  leagueEpochMs, nextPracticeEventAt, parsePracticeControlRaw,
  pausePracticeControl, restartPracticeControl, resumePracticeControl, slotsForDate,
} from '../src/practice-clock.js';
import { hasCoachKey } from '../src/payload.js';
import { startServer } from './_server.js';

const TZ = 'America/Chicago';

function demoData(overrides: Partial<PracticeData> = {}): PracticeData {
  const mk = (day: number, start: string, entries: [string, string][]) =>
    entries.map(([court, name]) => ({ day, start, court, team: { name, coach: 'DemoCoach' } }));
  return {
    days: [
      { day: 1, start: '17:00', end: '21:00' },
      { day: 2, start: '17:00', end: '19:00' },
      { day: 3, start: '16:30', end: '18:30' },
      { day: 4, start: '17:00', end: '18:00' },
    ],
    basketball: [
      // Deliberately scrambled court order on 17:00 to verify west1, west2, east1, east2 sorting.
      ...mk(1, '17:00', [['east2', 'Hawks'], ['west2', 'Lions'], ['east1', 'Bears'], ['west1', 'Eagles']]),
      ...mk(1, '18:00', [['west1', 'Tigers'], ['west2', 'Rams'], ['east1', 'Knights'], ['east2', 'Warriors']]),
      ...mk(1, '19:00', [['west1', 'Panthers'], ['east1', 'Falcons']]),
      ...mk(1, '20:00', [['west1', 'Wildcats'], ['east2', 'Mustangs']]),
      // Tuesday: 17:00 has teams, 18:00 is EMPTY (no teams).
      ...mk(2, '17:00', [['west1', 'Lady Stars'], ['east1', 'Lady Comets']]),
      // Wednesday half-hour slots.
      ...mk(3, '16:30', [['west1', 'Lady Lightning']]),
      ...mk(3, '17:30', [['east2', 'Lady Sparks']]),
      // Thursday single slot.
      ...mk(4, '17:00', [['west1', 'Lady Hornets'], ['west2', 'Lady Cardinals']]),
    ],
    cheer: [{ day: 1, room: 'Room 20' }, { day: 4, room: 'Room 28/30' }],
    range: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------- pure: CST/CDT anchors & labels
test('practice-clock pure: CST and CDT epoch anchors + slot labels', () => {
  assert.equal(formatSlotLabel('17:00'), '5:00 PM');
  assert.equal(formatSlotLabel('16:30'), '4:30 PM');
  assert.equal(formatSlotLabel('09:00'), '9:00 AM');
  assert.equal(formatSlotLabel('12:00'), '12:00 PM');

  // Mon 2026-11-30 is CST (UTC-6): 17:00 CST = 23:00Z
  assert.equal(leagueEpochMs('2026-11-30', '17:00', TZ), Date.parse('2026-11-30T23:00:00Z'));
  // Mon 2026-07-06 is CDT (UTC-5): 17:00 CDT = 22:00Z
  assert.equal(leagueEpochMs('2026-07-06', '17:00', TZ), Date.parse('2026-07-06T22:00:00Z'));
  // Fall-back DST Sunday 2026-11-01 evening is CST (UTC-6): 17:00 CST = 23:00Z
  assert.equal(leagueEpochMs('2026-11-01', '17:00', TZ), Date.parse('2026-11-01T23:00:00Z'));
  // Spring-forward DST Sunday 2026-03-08 evening is CDT (UTC-5): 17:00 CDT = 22:00Z
  assert.equal(leagueEpochMs('2026-03-08', '17:00', TZ), Date.parse('2026-03-08T22:00:00Z'));
});

// ---------------------------------------------------------------- pure: current slot & team order
test('practice-clock pure: current slot boundaries (16:59 / 17:00 / 17:59:59 / 18:00 / after last), team order, no coaches', () => {
  const d = demoData();
  const at = (iso: string) => Date.parse(iso);

  // 16:59:59 CST (EARLY_MIN is NOT used) -> null
  assert.equal(currentPractice(d, at('2026-11-30T22:59:59Z'), null, TZ), null);

  // 17:00:00 CST -> 17:00 slot, teams ordered west1, west2, east1, east2
  const s17 = currentPractice(d, at('2026-11-30T23:00:00Z'), null, TZ);
  assert.ok(s17);
  assert.deepEqual(s17.view.slot, { date: '2026-11-30', start: '17:00' });
  assert.equal(s17.view.label, '5:00 PM');
  assert.deepEqual(s17.view.teams, ['Eagles', 'Lions', 'Bears', 'Hawks']);
  assert.equal(hasCoachKey(s17.view), false);
  assert.equal(s17.view.paused, false);
  assert.deepEqual(s17.view.devo, { running: true, remainingMs: DEVO_MS, startedAt: at('2026-11-30T23:00:00Z') });
  assert.deepEqual(s17.view.end, { running: true, remainingMs: END_MS, startedAt: at('2026-11-30T23:00:00Z') });

  // 17:59:59 CST -> still 17:00 slot with 1s remaining on END
  const s1759 = currentPractice(d, at('2026-11-30T23:59:59Z'), null, TZ);
  assert.ok(s1759);
  assert.equal(s1759.view.slot.start, '17:00');
  assert.equal(s1759.view.devo.remainingMs, 0);
  assert.equal(s1759.view.devo.running, false);
  assert.equal(s1759.view.end.remainingMs, 1000);
  assert.equal(s1759.view.end.running, true);

  // 18:00:00 CST -> switches to 18:00 slot with fresh 25:00 / 60:00
  const s18 = currentPractice(d, at('2026-12-01T00:00:00Z'), null, TZ);
  assert.ok(s18);
  assert.equal(s18.view.slot.start, '18:00');
  assert.equal(s18.view.label, '6:00 PM');
  assert.deepEqual(s18.view.teams, ['Tigers', 'Rams', 'Knights', 'Warriors']);
  assert.equal(s18.view.devo.remainingMs, DEVO_MS);
  assert.equal(s18.view.end.remainingMs, END_MS);

  // After the last slot (21:00:00 CST = 2026-12-01T03:00:00Z) -> null
  assert.equal(currentPractice(d, at('2026-12-01T02:59:59Z'), null, TZ)?.view.slot.start, '20:00');
  assert.equal(currentPractice(d, at('2026-12-01T03:00:00Z'), null, TZ), null);
});

// ---------------------------------------------------------------- pure: Friday, cheer-only, range, empty slot, cap
test('practice-clock pure: Friday, cheer-only, out of range, empty slot, last-slot 3h cap', () => {
  const d = demoData();

  // Friday 17:10 CST -> null
  assert.equal(currentPractice(d, Date.parse('2026-12-04T23:10:00Z'), null, TZ), null);

  // Cheer-only schedule (no basketball entries at all) -> null even on Monday 17:10
  const cheerOnly = demoData({ basketball: [] });
  assert.equal(currentPractice(cheerOnly, Date.parse('2026-11-30T23:10:00Z'), null, TZ), null);

  // Season range: before start and after end -> null; inside range -> active
  const ranged = demoData({ range: { start: '2026-12-07', end: '2026-12-17' } });
  assert.equal(currentPractice(ranged, Date.parse('2026-11-30T23:10:00Z'), null, TZ), null, 'before range');
  assert.ok(currentPractice(ranged, Date.parse('2026-12-07T23:10:00Z'), null, TZ), 'on range start');
  assert.equal(currentPractice(ranged, Date.parse('2026-12-21T23:10:00Z'), null, TZ), null, 'after range');

  // Empty slot: Tuesday has 17:00 teams, 18:00 empty; also test gap 17:00 (teams), 18:00 (empty), 19:00 (teams)
  assert.equal(slotsForDate(d, '2026-12-01', TZ).map((s) => s.start).join(','), '17:00');
  assert.ok(currentPractice(d, Date.parse('2026-12-01T23:30:00Z'), null, TZ), 'Tue 17:30 active');
  assert.equal(currentPractice(d, Date.parse('2026-12-02T00:00:00Z'), null, TZ), null, 'Tue 18:00 empty -> null');
  assert.equal(currentPractice(d, Date.parse('2026-12-02T00:30:00Z'), null, TZ), null, 'Tue 18:30 empty -> null');

  const gapped = demoData({
    basketball: [
      { day: 1, start: '17:00', court: 'west1', team: { name: 'Eagles' } },
      { day: 1, start: '19:00', court: 'west1', team: { name: 'Lions' } },
    ],
  });
  assert.equal(currentPractice(gapped, Date.parse('2026-11-30T23:30:00Z'), null, TZ)?.view.slot.start, '17:00');
  assert.equal(currentPractice(gapped, Date.parse('2026-12-01T00:30:00Z'), null, TZ), null, '18:00 gap has no practice mode');
  assert.equal(currentPractice(gapped, Date.parse('2026-12-01T01:00:00Z'), null, TZ)?.view.slot.start, '19:00');

  // Last-slot hard cap: Mon 20:00 paused at 20:10 extends past 21:00 until 23:00 (start + 3h)
  const start20 = leagueEpochMs('2026-11-30', '20:00', TZ);
  const paused20 = pausePracticeControl('2026-11-30 20:00', null, start20 + 10 * 60_000);
  const stillUp = currentPractice(d, start20 + LAST_SLOT_CAP_MS - 1000, paused20, TZ);
  assert.ok(stillUp);
  assert.equal(stillUp.view.paused, true);
  assert.equal(stillUp.view.end.remainingMs, 50 * 60_000);
  assert.equal(currentPractice(d, start20 + LAST_SLOT_CAP_MS, paused20, TZ), null, 'hard cap at start + 3h');
});

// ---------------------------------------------------------------- pure: clocks, pause/resume, restart, slot reset
test('practice-clock pure: clocks at T+0 / T+25m / T+60m, pause/resume math, restart, new slot reset', () => {
  const d = demoData();
  const t0 = leagueEpochMs('2026-11-30', '17:00', TZ);
  const slotKey = '2026-11-30 17:00';

  // T+0, T+25m, T+60m
  const c0 = computePracticeClocks(t0, { slotKey, restartAt: null, pausedAt: null, pausedMs: 0 }, t0);
  assert.equal(c0.devo.remainingMs, DEVO_MS); assert.equal(c0.end.remainingMs, END_MS);
  const c25 = computePracticeClocks(t0, { slotKey, restartAt: null, pausedAt: null, pausedMs: 0 }, t0 + DEVO_MS);
  assert.equal(c25.devo.remainingMs, 0); assert.equal(c25.devo.running, false);
  assert.equal(c25.end.remainingMs, 35 * 60_000); assert.equal(c25.end.running, true);
  const c60 = computePracticeClocks(t0, { slotKey, restartAt: null, pausedAt: null, pausedMs: 0 }, t0 + END_MS);
  assert.equal(c60.devo.remainingMs, 0); assert.equal(c60.end.remainingMs, 0); assert.equal(c60.end.running, false);

  // Pause at T+10m (idempotent), resume at T+15m (idempotent) -> 5m pausedMs
  let ctrl: PracticeClockControl = pausePracticeControl(slotKey, null, t0 + 10 * 60_000);
  assert.deepEqual(pausePracticeControl(slotKey, ctrl, t0 + 12 * 60_000), ctrl, 'pause is idempotent');
  const whilePaused = computePracticeClocks(t0, ctrl, t0 + 14 * 60_000);
  assert.equal(whilePaused.paused, true);
  assert.equal(whilePaused.devo.running, false);
  assert.equal(whilePaused.devo.startedAt, null);
  assert.equal(whilePaused.devo.remainingMs, 15 * 60_000);
  assert.equal(whilePaused.end.remainingMs, 50 * 60_000);

  ctrl = resumePracticeControl(slotKey, ctrl, t0 + 15 * 60_000);
  assert.deepEqual(resumePracticeControl(slotKey, ctrl, t0 + 16 * 60_000), ctrl, 'resume is idempotent');
  assert.equal(ctrl.pausedAt, null);
  assert.equal(ctrl.pausedMs, 5 * 60_000);
  const afterResume = computePracticeClocks(t0, ctrl, t0 + 20 * 60_000);
  assert.equal(afterResume.paused, false);
  assert.equal(afterResume.devo.remainingMs, 10 * 60_000);
  assert.equal(afterResume.end.remainingMs, 45 * 60_000);

  // Restart at T+10m -> back to 25:00/60:00 unpaused; at 18:00 the next slot STILL starts fresh!
  const restarted = restartPracticeControl(slotKey, t0 + 10 * 60_000);
  const at1720 = currentPractice(d, t0 + 20 * 60_000, restarted, TZ);
  assert.ok(at1720);
  assert.equal(at1720.view.devo.remainingMs, 15 * 60_000);
  assert.equal(at1720.view.end.remainingMs, 50 * 60_000);

  const at1800 = currentPractice(d, t0 + 60 * 60_000, restarted, TZ);
  assert.ok(at1800);
  assert.equal(at1800.slot.slotKey, '2026-11-30 18:00');
  assert.equal(at1800.control.restartAt, null, 'new slot resets control');
  assert.equal(at1800.control.pausedAt, null);
  assert.equal(at1800.view.devo.remainingMs, DEVO_MS);
  assert.equal(at1800.view.end.remainingMs, END_MS);
});

// ---------------------------------------------------------------- pure: next-event and zero-crossing
test('practice-clock pure: nextPracticeEventAt and dueBuzzEvents (exactly once, stale >2s ignored, restart re-arms)', () => {
  const d = demoData();
  const t0 = leagueEpochMs('2026-11-30', '17:00', TZ);
  const t18 = leagueEpochMs('2026-11-30', '18:00', TZ);
  const fired = new Set<string>();

  // Before 17:00 -> next event is 17:00 start
  assert.equal(nextPracticeEventAt(d, t0 - 5000, null, TZ), t0);
  assert.deepEqual(dueBuzzEvents(d, t0, null, fired, TZ), [], 'slot start does not buzz');

  // At 17:00 -> next event is DEVO 0 (17:25)
  assert.equal(nextPracticeEventAt(d, t0, null, TZ), t0 + DEVO_MS);

  // At DEVO 0 + 50 ms -> exactly one practice-devo buzz
  const b1 = dueBuzzEvents(d, t0 + DEVO_MS + 50, null, fired, TZ);
  assert.equal(b1.length, 1);
  assert.equal(b1[0].reason, 'practice-devo');
  fired.add(b1[0].key);
  assert.deepEqual(dueBuzzEvents(d, t0 + DEVO_MS + 100, null, fired, TZ), [], 'never fires twice');

  // Stale (> 2 s) -> never fires even if not in fired
  assert.deepEqual(dueBuzzEvents(d, t0 + DEVO_MS + STALE_BUZZ_MS + 1, null, new Set(), TZ), [], 'stale DEVO skipped');

  // After DEVO 0 -> next event is 18:00 (END 0 / next slot)
  assert.equal(nextPracticeEventAt(d, t0 + DEVO_MS + 100, null, TZ), t18);

  // At 18:00 + 20 ms -> END buzz of 17:00 fires once (not new slot buzz)
  const b2 = dueBuzzEvents(d, t18 + 20, null, fired, TZ);
  assert.equal(b2.length, 1);
  assert.equal(b2[0].reason, 'practice-end');
  assert.equal(b2[0].slotKey, '2026-11-30 17:00');
  fired.add(b2[0].key);
  assert.deepEqual(dueBuzzEvents(d, t18 + 50, null, fired, TZ), []);

  // Restart at 17:26 -> DEVO buzzes again at 17:51, and END does NOT buzz at 18:00 (pushed to 18:26 > 18:00)
  const restarted = restartPracticeControl('2026-11-30 17:00', t0 + 26 * 60_000);
  const fired2 = new Set<string>(['2026-11-30 17:00|0|devo']);
  const bRestart = dueBuzzEvents(d, t0 + 51 * 60_000 + 10, restarted, fired2, TZ);
  assert.equal(bRestart.length, 1);
  assert.equal(bRestart[0].reason, 'practice-devo');
  assert.deepEqual(dueBuzzEvents(d, t18 + 10, restarted, fired2, TZ), [], 'restarted 17:00 does not END-buzz at 18:00');

  // Paused 17:00 does not END-buzz at 18:00
  const paused17 = pausePracticeControl('2026-11-30 17:00', null, t0 + 10 * 60_000);
  assert.deepEqual(dueBuzzEvents(d, t18 + 10, paused17, new Set(), TZ), [], 'paused 17:00 does not END-buzz at 18:00');
});

// ---------------------------------------------------------------- pure: apply/ignore stored control
test('practice-clock pure: applyStoredControl / parsePracticeControlRaw (match -> applied; mismatch/missing/bad JSON -> ignored)', () => {
  const valid: PracticeClockControl = { slotKey: '2026-11-30 17:00', restartAt: null, pausedAt: 1796080000000, pausedMs: 5000 };
  const raw = JSON.stringify(valid);

  assert.deepEqual(applyStoredControl(raw, '2026-11-30 17:00'), valid, 'matching slotKey applied');
  assert.equal(applyStoredControl(raw, '2026-11-30 18:00'), null, 'different hour ignored');
  assert.equal(applyStoredControl(raw, '2026-12-01 17:00'), null, 'different day ignored');
  assert.equal(applyStoredControl(raw, null), null, 'no active slot ignored');
  assert.equal(applyStoredControl(null, '2026-11-30 17:00'), null, 'missing ignored');
  assert.equal(applyStoredControl(undefined, '2026-11-30 17:00'), null, 'undefined ignored');
  assert.equal(applyStoredControl('', '2026-11-30 17:00'), null, 'empty ignored');
  assert.equal(applyStoredControl('{bad json', '2026-11-30 17:00'), null, 'bad JSON ignored');
  assert.equal(parsePracticeControlRaw(JSON.stringify({ slotKey: 'bad', restartAt: null, pausedAt: null, pausedMs: 0 })), null, 'bad slotKey format');
  assert.equal(parsePracticeControlRaw(JSON.stringify({ slotKey: '2026-11-30 17:00', restartAt: null, pausedAt: null, pausedMs: -1 })), null, 'negative pausedMs');
  assert.equal(parsePracticeControlRaw(JSON.stringify({ slotKey: '2026-11-30 17:00', restartAt: 'nope', pausedAt: null, pausedMs: 0 })), null, 'non-numeric restartAt');
});

// ---------------------------------------------------------------- server + DB integration tests
const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skipDb = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test"' : false;

const procs: ChildProcess[] = [];
const createdDbs: string[] = [];

after(async () => {
  for (const p of procs) { try { p.kill(); } catch {} }
  if (!skipDb && createdDbs.length) {
    const admin = new pg.Client({ connectionString: BASE_URL });
    try {
      await admin.connect();
      for (const name of createdDbs) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    } finally { await admin.end().catch(() => {}); }
  }
});

const execFileAsync = promisify(execFile);
const SEED_DEMO_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/seed-demo.js');

async function freshDb(suffix: string, seedDemoAt?: string): Promise<string> {
  const u = new URL(BASE_URL);
  const name = `${u.pathname.slice(1)}_r2_${suffix}`;
  u.pathname = '/' + name;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  createdDbs.push(name);
  const dbUrl = u.toString();
  if (seedDemoAt) {
    // Seed before spawning the timed server so test-clock servers boot in <1 s and never overshoot 3-5 s transitions.
    await execFileAsync(process.execPath, [SEED_DEMO_SCRIPT], {
      env: { ...process.env, DATABASE_URL: dbUrl, TZ, SCOREBOARD_TEST_CLOCK: '1', SCOREBOARD_TEST_NOW: seedDemoAt },
    });
  }
  return dbUrl;
}

type Sock = { ws: WebSocket; msgs: any[]; next: (pred: (m: any) => boolean, ms?: number) => Promise<any>; waitNew: (pred: (m: any) => boolean, ms?: number) => Promise<any> };

function openSock(port: number, q: string, token?: string): Promise<Sock> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${q}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    const msgs: any[] = [];
    const waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      msgs.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
      }
    });
    const next = (pred: (m: any) => boolean, ms = 6000) => new Promise<any>((r2, j2) => {
      const hit = msgs.find(pred);
      if (hit) return r2(hit);
      const w = { pred, res: r2 };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); j2(new Error(`timeout waiting on ${q}`)); } }, ms);
    });
    const waitNew = (pred: (m: any) => boolean, ms = 6000) => new Promise<any>((r2, j2) => {
      const w = { pred, res: r2 };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); j2(new Error(`timeout waiting new msg on ${q}`)); } }, ms);
    });
    ws.on('open', () => res({ ws, msgs, next, waitNew }));
    ws.on('error', rej);
  });
}

async function stopProc(p: ChildProcess) {
  if (p.exitCode !== null || p.killed) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3000);
    p.once('exit', () => { clearTimeout(t); resolve(); });
    p.kill();
  });
}

async function makeApi(port: number) {
  const BASE = `http://127.0.0.1:${port}`;
  const req = async (p: string, method = 'GET', body?: unknown, tok = '') => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (tok) headers.authorization = `Bearer ${tok}`;
    const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let b: any; try { b = JSON.parse(t); } catch { b = t; }
    return { status: r.status, body: b };
  };
  const login = await req('/api/login', 'POST', { password: 'r2-test-password' });
  const token = login.body.token as string;
  assert.ok(token);
  return {
    token,
    get: (p: string, auth = true) => req(p, 'GET', undefined, auth ? token : ''),
    post: (p: string, body?: unknown, auth = true) => req(p, 'POST', body, auth ? token : ''),
  };
}

function serverEnv(dbUrl: string, testNow: string, seed = '') {
  return {
    DATABASE_URL: dbUrl,
    ADMIN_PASSWORD: 'r2-test-password',
    SESSION_SECRET: 'r2-test-secret-long-enough',
    COURT_PINS: 'full:1111,west:2222,east:3333',
    TZ,
    SEED: seed,
    SCOREBOARD_TEST_CLOCK: '1',
    SCOREBOARD_TEST_NOW: testNow,
  };
}

test('server: Monday 16:59:48 -> 17:00 switch on all TVs, Admin 401/409/pause/resume/restart, active game wins per court', { skip: skipDb, timeout: 90_000 }, async () => {
  const dbUrl = await freshDb('main', '2026-11-30T22:59:48Z');
  const started = await startServer(serverEnv(dbUrl, '2026-11-30T22:59:48Z'));
  procs.push(started.srv);
  const api = await makeApi(started.port);

  const tvFull = await openSock(started.port, 'court=full&role=tv');
  const tvWest = await openSock(started.port, 'court=west&role=tv');
  const tvEast = await openSock(started.port, 'court=east&role=tv');
  const ovFull = await openSock(started.port, 'court=full&role=overlay');
  const scFull = await openSock(started.port, 'court=full&role=score', api.token);

  // Initial state before 17:00: practice is null
  for (const s of [tvFull, tvWest, tvEast]) {
    const st = await s.next((m) => m.type === 'state');
    assert.equal(st.practice, null, 'practice null before 17:00');
  }

  // Admin 401 without token, 409 before slot starts
  assert.equal((await api.get('/api/practice/clock', false)).status, 401);
  assert.equal((await api.post('/api/practice/clock/pause', {}, false)).status, 401);
  assert.equal((await api.post('/api/practice/clock/pause', {})).status, 409);
  assert.equal((await api.post('/api/practice/clock/resume', {})).status, 409);
  assert.equal((await api.post('/api/practice/clock/restart', {})).status, 409);
  assert.equal((await api.get('/api/practice/clock')).body.practice, null);

  // When 17:00 arrives, all three TVs switch to the 17:00 practice with matching anchors
  const [pFull, pWest, pEast] = await Promise.all([
    tvFull.next((m) => m.type === 'state' && m.practice != null, 18000),
    tvWest.next((m) => m.type === 'state' && m.practice != null, 18000),
    tvEast.next((m) => m.type === 'state' && m.practice != null, 18000),
  ]);
  for (const m of [pFull, pWest, pEast]) {
    assert.deepEqual(m.practice.slot, { date: '2026-11-30', start: '17:00' });
    assert.equal(m.practice.label, '5:00 PM');
    assert.equal(m.practice.teams.length, 4);
    assert.equal(m.practice.paused, false);
    assert.equal(m.practice.devo.running, true);
    assert.equal(m.practice.end.running, true);
    assert.equal(hasCoachKey(m.practice), false);
  }
  const anchor = (m: any) => m.practice.devo.startedAt - (DEVO_MS - m.practice.devo.remainingMs);
  assert.ok(Math.abs(anchor(pFull) - anchor(pWest)) <= 50, 'same anchor full/west');
  assert.ok(Math.abs(anchor(pFull) - anchor(pEast)) <= 50, 'same anchor full/east');

  // Admin Pause -> all three TVs get paused=true
  const waitPaused = Promise.all([
    tvFull.waitNew((m) => m.type === 'state' && m.practice?.paused === true),
    tvWest.waitNew((m) => m.type === 'state' && m.practice?.paused === true),
    tvEast.waitNew((m) => m.type === 'state' && m.practice?.paused === true),
  ]);
  const rPause = await api.post('/api/practice/clock/pause', {});
  assert.equal(rPause.status, 200);
  assert.equal(rPause.body.ok, true);
  assert.equal(rPause.body.tvs, 3);
  assert.equal(rPause.body.practice.paused, true);
  const pausedStates = await waitPaused;
  for (const m of pausedStates) {
    assert.equal(m.practice.devo.running, false);
    assert.equal(m.practice.end.running, false);
  }
  // Idempotent second pause
  assert.equal((await api.post('/api/practice/clock/pause', {})).status, 200);

  // Admin Resume -> all three TVs resume
  const waitResumed = Promise.all([
    tvFull.waitNew((m) => m.type === 'state' && m.practice?.paused === false),
    tvWest.waitNew((m) => m.type === 'state' && m.practice?.paused === false),
    tvEast.waitNew((m) => m.type === 'state' && m.practice?.paused === false),
  ]);
  const rResume = await api.post('/api/practice/clock/resume', {});
  assert.equal(rResume.status, 200);
  assert.equal(rResume.body.practice.paused, false);
  await waitResumed;

  // Wait 1.2 s then Restart -> clocks back near 25:00 / 60:00
  await new Promise((r) => setTimeout(r, 1200));
  const waitRestart = Promise.all([
    tvFull.waitNew((m) => m.type === 'state' && m.practice?.devo.remainingMs >= DEVO_MS - 500),
    tvWest.waitNew((m) => m.type === 'state' && m.practice?.devo.remainingMs >= DEVO_MS - 500),
    tvEast.waitNew((m) => m.type === 'state' && m.practice?.devo.remainingMs >= DEVO_MS - 500),
  ]);
  const rRestart = await api.post('/api/practice/clock/restart', {});
  assert.equal(rRestart.status, 200);
  assert.ok(rRestart.body.practice.devo.remainingMs >= DEVO_MS - 500);
  assert.ok(rRestart.body.practice.end.remainingMs >= END_MS - 500);
  await waitRestart;

  // Active game on west -> west gets game and practice=null, full/east keep practice
  const games = (await api.get('/api/games')).body as any[];
  const westGame = games.find((g) => g.court_slug === 'west' && g.status === 'scheduled');
  assert.ok(westGame);
  const waitWestGame = tvWest.waitNew((m) => m.type === 'state' && m.game?.id === westGame.id);
  assert.equal((await api.post(`/api/games/${westGame.id}/start`, {})).status, 200);
  const wState = await waitWestGame;
  assert.equal(wState.practice, null, 'active game wins on west');
  const fPub = (await api.get('/api/public/court/full')).body;
  assert.ok(fPub.practice, 'full stays in practice mode');

  // Verify no buzz occurred on slot start or overlay/score
  assert.equal(ovFull.msgs.some((m) => m.type === 'buzzer'), false);
  assert.equal(scFull.msgs.some((m) => m.type === 'buzzer'), false);

  for (const s of [tvFull, tvWest, tvEast, ovFull, scFull]) s.ws.close();
  await stopProc(started.srv);
});

test('server: DEVO 0 buzz (5000 ms) goes to practice TVs only; active game court, overlay, score get none', { skip: skipDb, timeout: 90_000 }, async () => {
  const dbUrl = await freshDb('devo', '2026-11-30T23:24:48Z');
  const started = await startServer(serverEnv(dbUrl, '2026-11-30T23:24:48Z'));
  procs.push(started.srv);
  const api = await makeApi(started.port);

  // Start a game on west so west has an active game during the DEVO buzz
  const games = (await api.get('/api/games')).body as any[];
  const westGame = games.find((g) => g.court_slug === 'west' && g.status === 'scheduled');
  assert.ok(westGame);
  assert.equal((await api.post(`/api/games/${westGame.id}/start`, {})).status, 200);

  const tvFull = await openSock(started.port, 'court=full&role=tv');
  const tvWest = await openSock(started.port, 'court=west&role=tv');
  const tvEast = await openSock(started.port, 'court=east&role=tv');
  const ovFull = await openSock(started.port, 'court=full&role=overlay');
  const scFull = await openSock(started.port, 'court=full&role=score', api.token);

  const [bFull, bEast] = await Promise.all([
    tvFull.next((m) => m.type === 'buzzer', 18000),
    tvEast.next((m) => m.type === 'buzzer', 18000),
  ]);
  assert.equal(bFull.reason, 'practice-devo');
  assert.equal(bFull.durationMs, PRACTICE_BUZZ_MS);
  assert.equal(bEast.reason, 'practice-devo');
  assert.equal(bEast.durationMs, PRACTICE_BUZZ_MS);

  await new Promise((r) => setTimeout(r, 800));
  assert.equal(tvFull.msgs.filter((m) => m.type === 'buzzer').length, 1, 'exactly one DEVO buzz on full');
  assert.equal(tvEast.msgs.filter((m) => m.type === 'buzzer').length, 1, 'exactly one DEVO buzz on east');
  assert.equal(tvWest.msgs.some((m) => m.type === 'buzzer'), false, 'active-game west gets no practice buzz');
  assert.equal(ovFull.msgs.some((m) => m.type === 'buzzer'), false, 'overlay gets no buzz');
  assert.equal(scFull.msgs.some((m) => m.type === 'buzzer'), false, 'scorekeeper gets no buzz');

  for (const s of [tvFull, tvWest, tvEast, ovFull, scFull]) s.ws.close();
  await stopProc(started.srv);
});

test('server: END buzz at 18:00 rolls into fresh 18:00 slot; last slot END buzz returns TVs to idle', { skip: skipDb, timeout: 90_000 }, async () => {
  // Part A: 17:59:48 CST -> END buzz + 18:00 slot
  const dbUrl = await freshDb('end', '2026-11-30T23:59:48Z');
  const started = await startServer(serverEnv(dbUrl, '2026-11-30T23:59:48Z'));
  procs.push(started.srv);

  const tvFull = await openSock(started.port, 'court=full&role=tv');
  const tvWest = await openSock(started.port, 'court=west&role=tv');
  const tvEast = await openSock(started.port, 'court=east&role=tv');

  await tvFull.next((m) => m.type === 'state' && m.practice?.slot.start === '17:00', 10000);

  const [bFull, bWest, bEast, s18] = await Promise.all([
    tvFull.next((m) => m.type === 'buzzer', 18000),
    tvWest.next((m) => m.type === 'buzzer', 18000),
    tvEast.next((m) => m.type === 'buzzer', 18000),
    tvFull.next((m) => m.type === 'state' && m.practice?.slot.start === '18:00', 18000),
  ]);
  for (const b of [bFull, bWest, bEast]) {
    assert.equal(b.reason, 'practice-end');
    assert.equal(b.durationMs, PRACTICE_BUZZ_MS);
  }
  assert.equal(s18.practice.label, '6:00 PM');
  assert.equal(s18.practice.teams.length, 4);
  assert.ok(s18.practice.devo.remainingMs > DEVO_MS - 3000, 'fresh 25:00 DEVO');
  assert.ok(s18.practice.end.remainingMs > END_MS - 3000, 'fresh 60:00 END');

  for (const s of [tvFull, tvWest, tvEast]) s.ws.close();
  await stopProc(started.srv);

  // Part B: Thursday 17:59:48 CST (Thu 17:00-18:00 is the last slot) -> END buzz + practice becomes null (idle)
  const dbLast = await freshDb('last', '2026-12-03T23:59:48Z');
  const sLast = await startServer(serverEnv(dbLast, '2026-12-03T23:59:48Z'));
  procs.push(sLast.srv);
  const tvLast = await openSock(sLast.port, 'court=full&role=tv');
  await tvLast.next((m) => m.type === 'state' && m.practice?.slot.start === '17:00', 10000);
  const [bLast, idleState] = await Promise.all([
    tvLast.next((m) => m.type === 'buzzer', 18000),
    tvLast.waitNew((m) => m.type === 'state' && m.practice === null, 18000),
  ]);
  assert.equal(bLast.reason, 'practice-end');
  assert.equal(bLast.durationMs, PRACTICE_BUZZ_MS);
  assert.equal(idleState.practice, null, 'back to idle after last slot');
  tvLast.ws.close();
  await stopProc(sLast.srv);
});

test('server: Friday clock has no practice mode', { skip: skipDb, timeout: 60_000 }, async () => {
  const dbUrl = await freshDb('fri', '2026-12-04T23:10:00Z');
  const started = await startServer(serverEnv(dbUrl, '2026-12-04T23:10:00Z')); // Fri 17:10 CST
  procs.push(started.srv);
  const api = await makeApi(started.port);
  const tv = await openSock(started.port, 'court=full&role=tv');
  const st = await tv.next((m) => m.type === 'state');
  assert.equal(st.practice, null);
  assert.equal((await api.get('/api/practice/clock')).body.practice, null);
  assert.equal((await api.post('/api/practice/clock/pause', {})).status, 409);
  tv.ws.close();
  await stopProc(started.srv);
});

test('server: AC 12 persistence — Pause and Restart survive server restarts; stale rows are ignored and deleted', { skip: skipDb, timeout: 90_000 }, async () => {
  const dbUrl = await freshDb('persist', '2026-11-30T23:06:40Z');
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();

  const readSetting = async () => (await db.query('SELECT value FROM settings WHERE key=$1', [PRACTICE_CLOCK_KEY])).rows[0]?.value ?? null;

  try {
    // 1) Pause at Mon 17:06:40 CST (DEVO ~18:20 / END ~53:20), restart server 10 s later
    const s1 = await startServer(serverEnv(dbUrl, '2026-11-30T23:06:40Z'));
    procs.push(s1.srv);
    const api1 = await makeApi(s1.port);
    const paused = await api1.post('/api/practice/clock/pause', {});
    assert.equal(paused.status, 200);
    const preDevo = paused.body.practice.devo.remainingMs;
    const preEnd = paused.body.practice.end.remainingMs;
    const rawAfterPause = await readSetting();
    assert.ok(rawAfterPause, 'practice_clock persisted in settings');
    assert.equal(JSON.parse(rawAfterPause).slotKey, '2026-11-30 17:00');
    await stopProc(s1.srv);

    // Server #2 at 17:06:50 CST: must come back PAUSED at the same remaining times (+-1500 ms)
    const s2 = await startServer(serverEnv(dbUrl, '2026-11-30T23:06:50Z'));
    procs.push(s2.srv);
    const tv2 = await openSock(s2.port, 'court=full&role=tv');
    const st2 = await tv2.next((m) => m.type === 'state' && m.practice != null);
    assert.equal(st2.practice.paused, true, 'still paused after restart');
    assert.ok(Math.abs(st2.practice.devo.remainingMs - preDevo) <= 1500, `devo matches pre-restart (${st2.practice.devo.remainingMs} vs ${preDevo})`);
    assert.ok(Math.abs(st2.practice.end.remainingMs - preEnd) <= 1500, `end matches pre-restart (${st2.practice.end.remainingMs} vs ${preEnd})`);

    // Resume on server #2
    const api2 = await makeApi(s2.port);
    const res2 = await api2.post('/api/practice/clock/resume', {});
    assert.equal(res2.status, 200);
    assert.equal(res2.body.practice.paused, false);
    tv2.ws.close();
    await stopProc(s2.srv);

    // 2) Restart via Admin at ~T+10m (17:10:00), then restart server 8 s later (17:10:08)
    const s3 = await startServer(serverEnv(dbUrl, '2026-11-30T23:10:00Z'));
    procs.push(s3.srv);
    const api3 = await makeApi(s3.port);
    const rst3 = await api3.post('/api/practice/clock/restart', {});
    assert.equal(rst3.status, 200);
    const restartAnchor = JSON.parse((await readSetting())!).restartAt as number;
    assert.ok(typeof restartAnchor === 'number' && restartAnchor > 0);
    await stopProc(s3.srv);

    const s4 = await startServer(serverEnv(dbUrl, '2026-11-30T23:10:08Z'));
    procs.push(s4.srv);
    const tv4 = await openSock(s4.port, 'court=full&role=tv');
    const st4 = await tv4.next((m) => m.type === 'state' && m.practice != null);
    assert.equal(st4.practice.paused, false);
    const expectedElapsed = st4.serverNow - restartAnchor;
    assert.ok(Math.abs(st4.practice.devo.remainingMs - (DEVO_MS - expectedElapsed)) <= 1500, 'devo uses restart anchor');
    assert.ok(Math.abs(st4.practice.end.remainingMs - (END_MS - expectedElapsed)) <= 1500, 'end uses restart anchor');
    assert.ok(st4.practice.devo.remainingMs > 24 * 60_000, 'did not jump back to 17:00 schedule anchor');

    // Leave a paused 17:00 row in place before stopping server #4
    const api4 = await makeApi(s4.port);
    assert.equal((await api4.post('/api/practice/clock/pause', {})).status, 200);
    tv4.ws.close();
    await stopProc(s4.srv);

    // 3) Stale row from 17:00 when server starts at 18:00:05 -> ignored and deleted; 18:00 runs unpaused from schedule anchor
    const s5 = await startServer(serverEnv(dbUrl, '2026-12-01T00:00:05Z'));
    procs.push(s5.srv);
    const tv5 = await openSock(s5.port, 'court=full&role=tv');
    const st5 = await tv5.next((m) => m.type === 'state' && m.practice != null);
    assert.equal(st5.practice.slot.start, '18:00');
    assert.equal(st5.practice.paused, false);
    const start18 = leagueEpochMs('2026-11-30', '18:00', TZ);
    assert.ok(Math.abs(st5.practice.devo.remainingMs - (DEVO_MS - (st5.serverNow - start18))) <= 1500, '18:00 devo follows 18:00 anchor');
    assert.ok(Math.abs(st5.practice.end.remainingMs - (END_MS - (st5.serverNow - start18))) <= 1500, '18:00 end follows 18:00 anchor');
    assert.equal(await readSetting(), null, 'stale 17:00 practice_clock row deleted');
    tv5.ws.close();
    await stopProc(s5.srv);

    // 4) Stale row from night before when server starts Tue 17:00:05 -> ignored and deleted
    await db.query(
      'INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
      [PRACTICE_CLOCK_KEY, JSON.stringify({ slotKey: '2026-11-30 17:00', restartAt: null, pausedAt: Date.parse('2026-11-30T23:10:00Z'), pausedMs: 0 })],
    );
    const s6 = await startServer(serverEnv(dbUrl, '2026-12-01T23:00:05Z'));
    procs.push(s6.srv);
    const tv6 = await openSock(s6.port, 'court=west&role=tv');
    const st6 = await tv6.next((m) => m.type === 'state' && m.practice != null);
    assert.deepEqual(st6.practice.slot, { date: '2026-12-01', start: '17:00' });
    assert.equal(st6.practice.paused, false);
    const startTue17 = leagueEpochMs('2026-12-01', '17:00', TZ);
    assert.ok(Math.abs(st6.practice.devo.remainingMs - (DEVO_MS - (st6.serverNow - startTue17))) <= 1500, 'Tue 17:00 devo follows Tue anchor');
    assert.equal(await readSetting(), null, 'stale prior-night row deleted');
    tv6.ws.close();
    await stopProc(s6.srv);
  } finally {
    await db.end();
  }
});
