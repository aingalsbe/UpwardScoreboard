// Release 1 (Aaron, 2026-11-23): branding, timeouts/fouls rule, full court detection, auto-advance + halftime fix,
// buzzer, practice :30 rotation and clean URLs. Pure parts always run; the server part needs TEST_DATABASE_URL
// (its own database "<name>_release1").
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChildProcess } from 'node:child_process';
import pg from 'pg';
import { WebSocket } from 'ws';
import {
  initialState, apply, newHistory, dispatch, undo, withFullCourtTimeouts, release1Refusal, FULL_COURT_TIMEOUTS_PER_HALF, GameState,
  canStartOvertime, OVERTIME_WINDOW_MS,
} from '../src/game.js';
import { isFullCourtGame } from '../src/schedule.js';
import { brandText, BRAND } from '../src/brand.js';
import { startServer } from './_server.js';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const T0 = 1_700_000_000_000;
const L = 60_000;

// ---------------------------------------------------------------- full court detection
test('full court: Court "Full" (slug full / name Full) OR 5th-6th Grade (grade or division); nothing else', () => {
  assert.equal(isFullCourtGame({ courtSlug: 'full', courtName: 'Full', grades: ['3rd-4th Grade'] }), true, 'Full court, any grade');
  assert.equal(isFullCourtGame({ courtSlug: 'main', courtName: 'Full' }), true, 'court named Full');
  assert.equal(isFullCourtGame({ courtSlug: 'x', courtName: 'Full Court' }), true);
  assert.equal(isFullCourtGame({ courtSlug: 'west', courtName: 'West', grades: ['5th-6th Grade', '5th-6th Grade'] }), true, '5th-6th on a half court');
  assert.equal(isFullCourtGame({ courtSlug: 'east', grades: [null, '6th Grade'] }), true, 'legacy single grade');
  assert.equal(isFullCourtGame({ courtSlug: 'east', grades: ['5th grade'] }), true);
  assert.equal(isFullCourtGame({ courtSlug: 'west', grades: [null, null], division: '5th-6th Grade Girls' }), true, 'division text');
  assert.equal(isFullCourtGame({ courtSlug: 'west', division: 'Grades 5-6 Boys' }), true);
  for (const g of ['3rd-4th Grade', '1st-2nd Grade', 'Kindergarten', '4th-5th Grade', '7th Grade', '', null])
    assert.equal(isFullCourtGame({ courtSlug: 'west', courtName: 'West', grades: [g, g], division: g }), false, String(g));
  assert.equal(isFullCourtGame({ courtSlug: null, courtName: null }), false, 'no court');
  assert.equal(isFullCourtGame({ courtSlug: 'fullerton', courtName: 'Fullerton' }), false);
});

// ---------------------------------------------------------------- timeouts and fouls rule
test('timeouts rule: full court = 1 per team per half, reset at halftime (no carry-over); fouls never; non-full-court no timeouts', () => {
  assert.equal(FULL_COURT_TIMEOUTS_PER_HALF, 1);
  assert.equal(release1Refusal({ type: 'FOUL' }, true), 'Fouls are not kept.');
  assert.equal(release1Refusal({ type: 'FOUL' }, false), 'Fouls are not kept.');
  assert.match(String(release1Refusal({ type: 'TIMEOUT' }, false)), /only kept for full court/);
  assert.equal(release1Refusal({ type: 'TIMEOUT' }, true), null);
  for (const t of ['SCORE', 'CLOCK_START', 'PERIOD', 'POSSESSION', 'END_GAME']) { assert.equal(release1Refusal({ type: t }, false), null); assert.equal(release1Refusal({ type: t }, true), null); }

  const base = initialState({ periodLengthMs: L }); // league rules: 2 per half
  let s = withFullCourtTimeouts(base);
  assert.equal(s.rules.timeoutsPerHalf, 1); assert.equal(s.home.timeoutsLeft, 1); assert.equal(s.away.timeoutsLeft, 1);
  assert.equal(withFullCourtTimeouts(s), s, 'idempotent (same object)');
  assert.equal(base.home.timeoutsLeft, 2, 'input untouched');
  s = apply(s, { type: 'TIMEOUT', team: 'home', delta: -1 }, T0);
  assert.equal(s.home.timeoutsLeft, 0);
  assert.equal(apply(s, { type: 'TIMEOUT', team: 'home', delta: -1 }, T0), s, 'no second timeout in the half');
  // away keeps its unused one through the half; at halftime both are back to exactly 1 (no carry-over to 2)
  s = apply(s, { type: 'PERIOD', delta: 1 }, T0); s = apply(s, { type: 'PERIOD', delta: 1 }, T0);
  assert.equal(s.home.timeoutsLeft, 0, 'same half: not refilled');
  s = apply(s, { type: 'CLOCK_START' }, T0); s = apply(s, { type: 'CLOCK_EXPIRE' }, T0 + L + 1); // end of P3 -> P4 (auto)
  assert.equal(s.period, 4); assert.equal(s.home.timeoutsLeft, 1); assert.equal(s.away.timeoutsLeft, 1, 'unused timeout did not carry over');
  // already used state from a 2-per-half game is capped, never raised; plus/minus is not part of the state at all
  const used = { ...base, home: { ...base.home, timeoutsLeft: 0 } } as GameState;
  assert.equal(withFullCourtTimeouts(used).home.timeoutsLeft, 0);
  assert.equal(JSON.stringify(initialState()).match(/plus|minus/i), null);
});

// ---------------------------------------------------------------- auto-advance + halftime fix
test('auto-advance: at 0 every period moves on with the clock reset and STOPPED; the final period and OT end the game', () => {
  let s = initialState({ periodLengthMs: L });
  for (let p = 1; p <= 5; p++) {
    s = apply(s, { type: 'CLOCK_START' }, T0); const seq = s.seq;
    s = apply(s, { type: 'CLOCK_EXPIRE' }, T0 + L + 5);
    assert.equal(s.period, p + 1, `P${p} -> P${p + 1}`);
    assert.deepEqual(s.clock, { running: false, remainingMs: L, startedAt: null }, 'reset + stopped');
    assert.equal(s.seq, seq + 1); assert.equal(s.lastLabel, 'End of period');
    assert.equal(s.banner, p === 3 ? 'HALFTIME' : null);
  }
  s = apply(s, { type: 'SCORE', team: 'home', pts: 2 }, T0); s = apply(s, { type: 'SCORE', team: 'away', pts: 2 }, T0); // tied 2-2
  s = apply(s, { type: 'CLOCK_START' }, T0); s = apply(s, { type: 'CLOCK_EXPIRE' }, T0 + L + 5);
  // Aaron (answer #2): the final 0:00 ENDS the game by itself, no "Ready to end the game?" prompt.
  assert.equal(s.period, 6); assert.deepEqual(s.clock, { running: false, remainingMs: 0, startedAt: null });
  assert.equal(s.status, 'complete', 'auto-completed at the final 0:00'); assert.equal(s.banner, 'FINAL');
  assert.equal(s.autoEndedAt, T0 + L + 5); assert.equal(s.lastLabel, 'Final (clock 0:00)');
  // OT via Next: OVERTIME reopens the tie straight into OT1, clock reset and stopped
  assert.equal(canStartOvertime(s, T0 + L + 60_000), true);
  s = apply(s, { type: 'OVERTIME' }, T0 + L + 60_000);
  assert.equal(s.status, 'active'); assert.equal(s.period, 7); assert.equal(s.banner, null); assert.equal(s.autoEndedAt, null);
  assert.deepEqual(s.clock, { running: false, remainingMs: L, startedAt: null }); assert.equal(s.lastLabel, 'Overtime OT');
  assert.equal(s.home.score, 2); assert.equal(s.away.score, 2, 'scores carry into OT');
  // an OT period hitting 0 ends the game again; still tied -> OT2 is possible; a winner -> no more OT
  s = apply(s, { type: 'CLOCK_START' }, T0); s = apply(s, { type: 'CLOCK_EXPIRE' }, T0 + L + 5);
  assert.equal(s.period, 7); assert.equal(s.status, 'complete', 'OT auto-ends too');
  assert.equal(apply(s, { type: 'OVERTIME' }, T0 + L + 10).period, 8, 'OT2 after a tied OT');
  const won = { ...s, home: { ...s.home, score: 4 } } as GameState;
  assert.equal(canStartOvertime(won), false); assert.equal(apply(won, { type: 'OVERTIME' }, T0 + L + 10), won, 'no OT unless tied');
  // only an AUTO-ended game (not "Complete game"), only within the window, never past the last OT period
  const manual = apply(apply(initialState({ periodLengthMs: L }), { type: 'START_GAME' }, T0), { type: 'END_GAME' }, T0);
  assert.equal(canStartOvertime(manual), false); assert.equal(apply(manual, { type: 'OVERTIME' }, T0), manual);
  assert.equal(canStartOvertime(s, (s.autoEndedAt as number) + OVERTIME_WINDOW_MS + 1), false, 'window closed');
  assert.equal(canStartOvertime({ ...s, period: 10 } as GameState), false, 'OT4 is the last');
  // admin REOPEN of an auto-ended game clears the flag
  assert.equal(apply(s, { type: 'REOPEN' }, T0).autoEndedAt, null);
  // expire before 0 or on a stopped clock: no-op
  const r = apply(initialState({ periodLengthMs: L }), { type: 'CLOCK_START' }, T0);
  assert.equal(apply(r, { type: 'CLOCK_EXPIRE' }, T0 + 10), r);
});

test('halftime bug (regression): after the 1st half ends, START works right away in the 2nd half (no Prev/Next dance)', () => {
  let h = newHistory(initialState({ periodLengthMs: L }));
  let t = T0;
  for (let p = 1; p <= 3; p++) { h = dispatch(h, { type: 'CLOCK_START' }, t); t += L + 10; h = dispatch(h, { type: 'CLOCK_EXPIRE' }, t); t += 1000; }
  // Root cause on 71ab5c6: this left the game on P3 at 0:00 with HALFTIME up, and CLOCK_START at 0 was a silent no-op.
  assert.equal(h.present.period, 4); assert.equal(h.present.banner, 'HALFTIME'); assert.equal(h.present.clock.remainingMs, L);
  const seq = h.present.seq;
  h = dispatch(h, { type: 'CLOCK_START' }, t);
  assert.equal(h.present.seq, seq + 1, 'START accepted'); assert.equal(h.present.clock.running, true);
  assert.equal(h.present.banner, null, 'banner clears when the 2nd half starts');
  assert.equal(h.present.period, 4, '2nd half, not a replay of P3');
});

test('auto-advance is undoable (back to the ended period at 0:00, stopped) and Prev restores it too', () => {
  let h = newHistory(initialState({ periodLengthMs: L }));
  h = dispatch(h, { type: 'SCORE', team: 'home', pts: 2 }, T0);
  h = dispatch(h, { type: 'CLOCK_START' }, T0);
  h = dispatch(h, { type: 'CLOCK_EXPIRE' }, T0 + L + 5);
  assert.equal(h.present.period, 2); assert.equal(h.present.lastLabel, 'End of period');
  // a score in P2, then undo it: still P2 (the old code would have jumped back to P1)
  h = dispatch(h, { type: 'SCORE', team: 'away', pts: 3 }, T0 + L + 100);
  h = undo(h, T0 + L + 200);
  assert.equal(h.present.period, 2); assert.equal(h.present.away.score, 0); assert.equal(h.present.home.score, 2);
  h = undo(h, T0 + L + 300); // undo "End of period"
  assert.equal(h.present.period, 1); assert.deepEqual(h.present.clock, { running: false, remainingMs: 0, startedAt: null });
  // Prev right after the auto-advance: same place
  let s = apply(apply(initialState({ periodLengthMs: L }), { type: 'CLOCK_START' }, T0), { type: 'CLOCK_EXPIRE' }, T0 + L + 5);
  s = apply(s, { type: 'PERIOD', delta: -1 }, T0 + L + 10);
  assert.equal(s.period, 1); assert.equal(s.clock.remainingMs, 0);
});

test('overtime (Aaron #2): Undo right after "Start overtime" goes back to regulation at 0:00, ACTIVE (never back to complete)', () => {
  let h = newHistory(initialState({ periodLengthMs: L }));
  for (let p = 1; p <= 5; p++) h = dispatch(h, { type: 'PERIOD', delta: 1 }, T0); // P6
  h = dispatch(h, { type: 'CLOCK_START' }, T0); h = dispatch(h, { type: 'CLOCK_EXPIRE' }, T0 + L + 5);
  assert.equal(h.present.status, 'complete');
  h = dispatch(h, { type: 'OVERTIME' }, T0 + L + 1000);
  assert.equal(h.present.period, 7); assert.equal(h.present.status, 'active');
  h = undo(h, T0 + L + 2000);
  assert.equal(h.present.period, 6); assert.equal(h.present.status, 'active'); assert.equal(h.present.autoEndedAt, null);
  assert.deepEqual(h.present.clock, { running: false, remainingMs: 0, startedAt: null });
  // and the "Ready to end the game?" prompt is gone from the score screen
  const js = fs.readFileSync(path.join(PUB, 'score.js'), 'utf8'), html = fs.readFileSync(path.join(PUB, 'score.html'), 'utf8');
  assert.equal(/Ready to end the game/.test(js + html), false); assert.match(html, /id="ot-start"/); assert.match(js, /type: 'overtime'/);
});

// ---------------------------------------------------------------- practice :30 rotation (basketball only)
test('practice basketball: switches to the next slot at the :30 mark (5:30 PM shows the 6:00 PM practice); cheer unchanged', async () => {
  const { planPractice, rotation, EARLY_MIN } = await import(path.join(PUB, 'practice-view.js'));
  assert.equal(EARLY_MIN, 30);
  const t = (name: string) => ({ name, coach: null, logo: null });
  const data = { days: [{ day: 1, start: '17:00', end: '20:00' }, { day: 3, start: '16:30', end: '18:30' }],
    basketball: [{ day: 1, start: '17:00', court: 'west1', team: t('A') }, { day: 1, start: '18:00', court: 'west1', team: t('B') }, { day: 1, start: '19:00', court: 'west1', team: t('C') },
      { day: 3, start: '16:30', court: 'east1', team: t('D') }, { day: 3, start: '17:30', court: 'east1', team: t('E') }],
    cheer: [{ day: 1, room: 'Room 20', slotId: 1, squad: t('Q') }] };
  const cur = (hm: string, dow = 1) => { const p = planPractice(data, 'basketball', dow, hm); return p.current == null ? null : p.pages[p.current].time; };
  assert.equal(cur('16:29'), null, 'before 4:30: every slot pages');
  assert.equal(cur('16:30'), '17:00', '4:30 -> the 5:00 practice');
  assert.equal(cur('17:29'), '17:00');
  assert.equal(cur('17:30'), '18:00', '5:30 PM shows the 6:00 PM practice');
  assert.equal(cur('18:29'), '18:00'); assert.equal(cur('18:30'), '19:00');
  assert.equal(cur('19:59'), '19:00', 'last slot stays');
  assert.equal(cur('17:00', 3), '17:30', 'half-hour slots: 30 min before too (5:00 -> 5:30 slot)');
  const p = planPractice(data, 'basketball', 1, '17:30');
  assert.deepEqual([rotation(p, 0).index, rotation(p, 12).index], [1, 2], 'current 6:00 for 12 s, then up next 7:00');
  for (const hm of ['17:29', '17:30', '18:30']) assert.equal(planPractice(data, 'cheer', 1, hm).current, null, 'cheer has no time rotation');
});

// ---------------------------------------------------------------- branding + clean URL parsing + buzzer client
test('branding: "Upward Basketball and Cheer" on every page title; env text upgraded; identifiers unchanged', () => {
  assert.equal(BRAND, 'Upward Basketball and Cheer');
  assert.equal(brandText('Lenexa Baptist Church Upward Basketball'), 'Lenexa Baptist Church Upward Basketball and Cheer');
  assert.equal(brandText('UPWARD BASKETBALL'), 'UPWARD BASKETBALL AND CHEER');
  assert.equal(brandText('Upward Basketball and Cheer'), 'Upward Basketball and Cheer', 'idempotent');
  assert.equal(brandText('Lenexa Baptist Church Youth Basketball'), 'Lenexa Baptist Church Youth Basketball');
  for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(PUB, f), 'utf8');
    assert.match(html, /<title>[^<]*Upward Basketball and Cheer[^<]*<\/title>/, `${f} <title>`);
  }
  for (const f of fs.readdirSync(PUB).filter((x) => /\.(html|js)$/.test(x))) {
    const src = fs.readFileSync(path.join(PUB, f), 'utf8');
    assert.equal(/Upward Basketball(?! and Cheer| AND CHEER)/i.test(src.replace(/UPWARD BASKETBALL AND CHEER/g, '')), false, `${f}: bare "Upward Basketball"`);
  }
});

test('clean URLs: courtFromPath reads /westcourt, /fullcourt/overlay and every legacy form', async () => {
  const { courtFromPath } = await import(path.join(PUB, 'common.js'));
  const cases: [string, string][] = [['/westcourt', 'west'], ['/eastcourt/', 'east'], ['/fullcourt/overlay', 'full'],
    ['/upwardbasketballscores/westcourt', 'west'], ['/upwardbasketballscores/fullcourt/overlay', 'full'],
    ['/tv/east', 'east'], ['/score/west', 'west'], ['/overlay/full', 'full']];
  for (const [p, c] of cases) assert.equal(courtFromPath(p), c, p);
});

test('court TV buzzer client: 3 s, plays once per id, ignores stale replays; locked audio shows the tap-to-enable gate', async () => {
  const store = new Map<string, string>();
  const g = globalThis as any;
  g.window = { addEventListener() {}, AudioContext: undefined };
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  const { createBuzzer, BUZZER_MS } = await import(path.join(PUB, 'buzzer.js'));
  assert.equal(BUZZER_MS, 3000);
  const started: number[] = [];
  class FakeCtx {
    state = 'suspended'; currentTime = 0; destination = {}; onstatechange: any = null;
    resume() { this.state = 'running'; return Promise.resolve(); }
    createGain() { return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createBiquadFilter() { return { type: '', frequency: { value: 0 }, connect() {} }; }
    createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start(t: number) { started.push(t); }, stop() {} }; }
  }
  const gate = { hidden: false, querySelector: () => ({ textContent: '' }), addEventListener() {} };
  const root = { dataset: {} as any, classList: { add() {}, remove() {} } };
  // Locked first (no resume yet): build without auto-unlock by giving a ctx class whose resume is deferred
  class LockedCtx extends FakeCtx { resume() { return new Promise<void>(() => {}); } }
  const locked = createBuzzer({ gate, root, AudioCtx: LockedCtx });
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(gate.hidden, false, 'gate shows while audio is locked'); assert.equal(root.dataset.sound, 'locked');
  assert.equal(locked.play(), false, 'no sound until tapped');
  const b = createBuzzer({ gate, root, AudioCtx: FakeCtx });
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(gate.hidden, true, 'gate hidden once audio runs'); assert.equal(root.dataset.sound, 'on');
  assert.equal(store.get('sb-buzzer-enabled'), '1');
  const now = 5_000_000;
  assert.equal(b.onMessage({ type: 'buzzer', id: 'a', serverNow: now, durationMs: 3000 }, now + 50), true);
  assert.equal(b.onMessage({ type: 'buzzer', id: 'a', serverNow: now, durationMs: 3000 }, now + 60), false, 'same id never twice');
  assert.equal(b.onMessage({ type: 'buzzer', id: 'old', serverNow: now, durationMs: 3000 }, now + 5000), false, 'stale replay skipped');
  assert.equal(b.onMessage({ type: 'state' }, now), false);
  assert.ok(started.length >= 3, 'oscillators started');
  assert.equal(fs.readFileSync(path.join(PUB, 'tv.html'), 'utf8').includes('Tap to enable sound'), true);
  for (const f of ['lobby.html', 'overlay.html', 'score.html']) assert.equal(fs.readFileSync(path.join(PUB, f), 'utf8').includes('sound-gate'), false, `${f}: no buzzer`);
});

test('screens: no fouls/bonus on score screen and court TV; timeouts + buzzer button marked full-court only', () => {
  const score = fs.readFileSync(path.join(PUB, 'score.html'), 'utf8'), tv = fs.readFileSync(path.join(PUB, 'tv.html'), 'utf8');
  assert.equal(/"FOUL"/.test(score), false, 'no foul buttons'); assert.equal(/FOULS|BONUS|\.fouls/.test(tv), false, 'no fouls/bonus on the TV');
  assert.equal((score.match(/data-full-court[^>]*"TIMEOUT"/g) || []).length, 2, 'timeout buttons are full-court only');
  assert.match(score, /id="buzzer"[^>]*data-full-court[^>]*hidden/);
  assert.match(fs.readFileSync(path.join(PUB, 'admin.js'), 'utf8'), /g\.full_court \? `<p class="buzzer-row">/);
  assert.equal(/plus.?minus/i.test(score + tv), false);
});

// ---------------------------------------------------------------- server: rules, buzzer, auto-advance, clean URLs
const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skipDb = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test"' : false;
let srv: ChildProcess | null = null;
after(() => { srv?.kill(); });

test('server: full court rules, manual + auto buzzer to that court TV only, halftime auto-advance, clean + legacy URLs', { skip: skipDb, timeout: 60_000 }, async () => {
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_release1'; u.pathname = '/' + name;
  const admin = new pg.Client({ connectionString: BASE_URL }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.query(`CREATE DATABASE "${name}"`); await admin.end();
  const started = await startServer({ DATABASE_URL: u.toString(), ADMIN_PASSWORD: 'r1-test', TZ: 'America/Chicago', SEED: 'true', COURT_PINS: 'full:1111,west:2222,east:3333',
    LEAGUE_NAME: 'Lenexa Baptist Church Upward Basketball', SESSION_SECRET: 'r1-test-secret-long-enough' });
  srv = started.srv;
  const BASE = `http://127.0.0.1:${started.port}`;
  let token = '';
  const api = async (p: string, method = 'GET', body?: unknown) => {
    const r = await fetch(BASE + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let b: any; try { b = JSON.parse(t); } catch { b = t; }
    return { status: r.status, body: b, type: r.headers.get('content-type') || '' };
  };
  token = (await api('/api/login', 'POST', { password: 'r1-test' })).body.token; assert.ok(token);

  // -- sockets
  type Sock = { ws: WebSocket; msgs: any[]; next: (pred: (m: any) => boolean, ms?: number) => Promise<any> };
  const open = (q: string, auth = false, wsPath = '/ws') => new Promise<Sock>((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${started.port}${wsPath}?${q}`, auth ? { headers: { authorization: `Bearer ${token}` } } : {});
    const msgs: any[] = []; const waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = [];
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); msgs.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); } });
    const next = (pred: (m: any) => boolean, ms = 4000) => new Promise<any>((r2, j2) => {
      const hit = msgs.find(pred); if (hit) return r2(hit);
      const w = { pred, res: r2 }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); j2(new Error(`timeout waiting on ${q}`)); } }, ms);
    });
    ws.on('open', () => res({ ws, msgs, next })); ws.on('error', rej);
  });
  let n = 0;
  const cmd = async (s: Sock, c: any) => { const id = `c${++n}`; s.ws.send(JSON.stringify({ type: 'cmd', id, cmd: c })); return s.next((m) => m.id === id && (m.type === 'ack' || m.type === 'error')); };
  const state = async (court: string) => (await api(`/api/public/court/${court}`)).body;

  const games = (await api('/api/games')).body as any[];
  const fullGame = games.find((g) => g.court_slug === 'full' && g.grade === '3rd-4th Grade'); // Full court by court value
  const westGame = games.find((g) => g.court_slug === 'west' && g.grade === '3rd-4th Grade');
  assert.ok(fullGame && westGame);
  assert.equal(fullGame.full_court, true); assert.equal(westGame.full_court, false);
  assert.ok(games.filter((g) => g.grade === '5th-6th Grade').every((g) => g.full_court));

  // -- full court game (Court = Full, 3rd-4th Grade)
  assert.equal((await api(`/api/games/${fullGame.id}/start`, 'POST', {})).status, 200);
  let st = await state('full');
  assert.equal(st.game.fullCourt, true); assert.equal(st.game.state.rules.timeoutsPerHalf, 1); assert.equal(st.game.state.home.timeoutsLeft, 1);
  assert.equal(st.league, 'Lenexa Baptist Church Upward Basketball and Cheer', 'env branding');
  const score = await open('court=full&role=score', true);
  const tvFull = await open('court=full&role=tv'), tvWest = await open('court=west&role=tv'), ovFull = await open('court=full&role=overlay');
  await score.next((m) => m.type === 'state');
  const foul = await cmd(score, { type: 'FOUL', team: 'home', delta: 1 });
  assert.equal(foul.type, 'error'); assert.equal(foul.error, 'Fouls are not kept.');
  assert.equal((await cmd(score, { type: 'TIMEOUT', team: 'home', delta: -1 })).type, 'ack');
  st = await state('full'); assert.equal(st.game.state.home.timeoutsLeft, 0); assert.equal(st.game.state.home.fouls, 0);
  // manual buzzer from the score screen: that court's TV only
  score.ws.send(JSON.stringify({ type: 'buzzer', id: 'b1', gameId: fullGame.id }));
  const ack = await score.next((m) => m.id === 'b1');
  assert.equal(ack.type, 'ack'); assert.equal(ack.buzzer, true); assert.equal(ack.tvs, 1);
  const bz = await tvFull.next((m) => m.type === 'buzzer');
  assert.equal(bz.reason, 'manual'); assert.equal(bz.durationMs, 3000);
  // Admin buzzer
  const ab = await api(`/api/games/${fullGame.id}/buzzer`, 'POST');
  assert.equal(ab.status, 200); assert.equal(ab.body.tvs, 1);
  await tvFull.next((m) => m.type === 'buzzer' && m.id !== bz.id);
  // unauthenticated scorekeeper socket can't buzz
  const anon = await open('court=full&role=score');
  anon.ws.send(JSON.stringify({ type: 'buzzer', id: 'b2' }));
  assert.match((await anon.next((m) => m.id === 'b2')).error, /PIN required/);
  token = ''; assert.equal((await api(`/api/games/${fullGame.id}/buzzer`, 'POST')).status, 401); token = (await api('/api/login', 'POST', { password: 'r1-test' })).body.token;

  // auto-advance into the 2nd half + auto buzzer + START works at halftime (the bug)
  assert.equal((await cmd(score, { type: 'PERIOD', delta: 1 })).type, 'ack');
  assert.equal((await cmd(score, { type: 'PERIOD', delta: 1 })).type, 'ack'); // P3
  assert.equal((await cmd(score, { type: 'CLOCK_SET', ms: 400 })).type, 'ack');
  const before = tvFull.msgs.filter((m) => m.type === 'buzzer').length;
  assert.equal((await cmd(score, { type: 'CLOCK_START' })).type, 'ack');
  const auto = await tvFull.next((m) => m.type === 'buzzer' && m.reason === 'period', 3000);
  assert.ok(auto); assert.equal(tvFull.msgs.filter((m) => m.type === 'buzzer').length, before + 1);
  await new Promise((r) => setTimeout(r, 200));
  st = await state('full');
  assert.equal(st.game.state.period, 4); assert.equal(st.game.state.banner, 'HALFTIME');
  assert.deepEqual(st.game.state.clock, { running: false, remainingMs: 360_000, startedAt: null });
  assert.equal(st.game.state.home.timeoutsLeft, 1, 'timeouts reset at halftime');
  assert.equal((await cmd(score, { type: 'CLOCK_START' })).type, 'ack');
  st = await state('full'); assert.equal(st.game.state.clock.running, true, 'clock starts at halftime without Prev/Next'); assert.equal(st.game.state.period, 4);
  assert.equal(tvWest.msgs.some((m) => m.type === 'buzzer'), false, 'other court TV never buzzes');
  assert.equal(ovFull.msgs.some((m) => m.type === 'buzzer'), false, 'overlay never buzzes');

  // Aaron #2: the final 0:00 ends the game by itself (buzzer still plays); a tie goes on to OT from the scorekeeper
  const buzzes = () => tvFull.msgs.filter((m) => m.type === 'buzzer' && m.reason === 'period').length;
  const runOut = async (ms: number) => {
    const b0 = buzzes();
    assert.equal((await cmd(score, { type: 'CLOCK_SET', ms })).type, 'ack');
    assert.equal((await cmd(score, { type: 'CLOCK_START' })).type, 'ack');
    await tvFull.next(() => buzzes() > b0, 3000); await new Promise((r) => setTimeout(r, 250));
    assert.equal(buzzes(), b0 + 1, 'one 3 s buzzer at that 0:00');
  };
  assert.equal((await cmd(score, { type: 'CLOCK_STOP' })).type, 'ack');
  assert.equal((await cmd(score, { type: 'PERIOD', delta: 1 })).type, 'ack'); assert.equal((await cmd(score, { type: 'PERIOD', delta: 1 })).type, 'ack'); // P6
  assert.equal((await cmd(score, { type: 'SCORE', team: 'home', pts: 2 })).type, 'ack'); assert.equal((await cmd(score, { type: 'SCORE', team: 'away', pts: 2 })).type, 'ack');
  await runOut(400);
  let g = (await api('/api/games')).body.find((x: any) => x.id === fullGame.id);
  assert.equal(g.status, 'complete', 'auto-completed at the final 0:00');
  st = await state('full');
  assert.equal(st.game, null, 'court idle (current game cleared)'); assert.equal(st.lastFinal?.id, fullGame.id);
  assert.equal(st.overtime?.gameId, fullGame.id, 'tie: overtime offered'); assert.equal(st.overtime.nextLabel, 'OT'); assert.equal(st.overtime.score, 2);
  assert.match((await cmd(score, { type: 'SCORE', team: 'home', pts: 1 })).error, /No game is loaded/, 'nothing to score on after the auto-end');
  anon.ws.send(JSON.stringify({ type: 'overtime', id: 'ot0', gameId: fullGame.id }));
  assert.match((await anon.next((m) => m.id === 'ot0')).error, /PIN required/, 'OT needs the scorekeeper PIN');
  const swx = await open('court=west&role=score', true); await swx.next((m) => m.type === 'state');
  swx.ws.send(JSON.stringify({ type: 'overtime', id: 'ot1', gameId: fullGame.id }));
  assert.equal((await swx.next((m) => m.id === 'ot1')).type, 'error', 'another court cannot start this OT'); swx.ws.close();
  score.ws.send(JSON.stringify({ type: 'overtime', id: 'ot2', gameId: fullGame.id }));
  const ota = await score.next((m) => m.id === 'ot2'); assert.equal(ota.type, 'ack', JSON.stringify(ota)); assert.equal(ota.overtime, true);
  st = await state('full');
  assert.equal(st.game?.id, fullGame.id, 'court shows the game again'); assert.equal(st.game.state.status, 'active');
  assert.equal(st.game.state.period, 7); assert.deepEqual(st.game.state.clock, { running: false, remainingMs: 360_000, startedAt: null });
  assert.equal(st.game.state.home.score, 2); assert.equal(st.overtime, null);
  assert.equal((await api('/api/public/courts')).body.find((c: any) => c.slug === 'full').current_game_id, fullGame.id);
  // OT hits 0 with a winner: ends again, no further OT
  assert.equal((await cmd(score, { type: 'SCORE', team: 'home', pts: 1 })).type, 'ack');
  await runOut(400);
  g = (await api('/api/games')).body.find((x: any) => x.id === fullGame.id);
  assert.equal(g.status, 'complete', 'OT auto-ends'); st = await state('full');
  assert.equal(st.game, null); assert.equal(st.overtime, null, 'not tied: no OT offer');
  score.ws.send(JSON.stringify({ type: 'overtime', id: 'ot3', gameId: fullGame.id }));
  assert.match((await score.next((m) => m.id === 'ot3')).error, /Overtime can only start/);

  // -- non-full-court game (West, 3rd-4th): no timeouts, no buzzer
  assert.equal((await api(`/api/games/${westGame.id}/start`, 'POST', { force: true })).status, 200);
  const sw = await open('court=west&role=score', true); await sw.next((m) => m.type === 'state');
  assert.equal((await state('west')).game.fullCourt, false);
  const to = await cmd(sw, { type: 'TIMEOUT', team: 'home', delta: -1 });
  assert.equal(to.type, 'error'); assert.match(to.error, /only kept for full court/);
  assert.equal((await cmd(sw, { type: 'FOUL', team: 'away', delta: 1 })).type, 'error');
  assert.equal((await cmd(sw, { type: 'SCORE', team: 'away', pts: 2 })).type, 'ack');
  sw.ws.send(JSON.stringify({ type: 'buzzer', id: 'b3' }));
  assert.match((await sw.next((m) => m.id === 'b3')).error, /only for full court/);
  assert.equal((await api(`/api/games/${westGame.id}/buzzer`, 'POST')).status, 409);
  assert.equal((await api(`/api/games/${westGame.id}/complete`, 'POST')).status, 200);

  // -- 5th-6th Grade on a half court = full court (division rule)
  const fiveSix = games.find((g) => g.grade === '5th-6th Grade');
  const made = await api('/api/games', 'POST', { court_id: (await api('/api/courts')).body.find((c: any) => c.slug === 'east').id, home_team_id: fiveSix.home_team_id, away_team_id: fiveSix.away_team_id, division: '5th-6th Grade' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await api(`/api/games/${made.body.id}/start`, 'POST', { force: true })).status, 200);
  st = await state('east'); assert.equal(st.game.fullCourt, true); assert.equal(st.game.state.home.timeoutsLeft, 1);

  // -- clean URLs + legacy prefix (pages, assets, API, websocket)
  const page = async (p: string) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.text() }; };
  for (const [p, marker] of [['/westcourt', 'data-role="tv"'], ['/eastcourt', 'data-role="tv"'], ['/fullcourt/', 'data-role="tv"'], ['/fullcourt/overlay', 'data-role="overlay"'],
    ['/upwardbasketballscores/westcourt', 'data-role="tv"'], ['/upwardbasketballscores/fullcourt/overlay', 'data-role="overlay"'], ['/tv/west', 'data-role="tv"'],
    ['/lobby', 'data-role="lobby"'], ['/upwardbasketballscores/lobby', 'data-role="lobby"'], ['/practice/cheer?day=mon', 'practice.css'], ['/practice/basketball?day=thu&x=1', 'practice.css'],
    ['/upwardbasketballscores/practice/basketball?day=thu', 'practice.css'], ['/split', 'data-role="split"'], ['/upwardbasketballscores/split', 'data-role="split"'], ['/tv/split', 'data-role="split"'],
    ['/score/west', 'Scorekeeper'], ['/', 'Upward Basketball and Cheer'], ['/upwardbasketballscores/', 'Upward Basketball and Cheer'], ['/upwardbasketballscores', 'Upward Basketball and Cheer']] as const) {
    const r = await page(p); assert.equal(r.status, 200, p); assert.ok(r.body.includes(marker), `${p} has ${marker}`);
    if (r.body.includes('<title>')) assert.match(r.body, /<title>[^<]*Upward Basketball and Cheer/, `${p} title`);
  }
  const css = await page('/tv.css'), css2 = await page('/upwardbasketballscores/tv.css');
  assert.equal(css2.status, 200); assert.equal(css2.body, css.body, 'legacy asset path');
  const js2 = await page('/upwardbasketballscores/common.js'); assert.equal(js2.status, 200); assert.ok(js2.body.includes('courtFromPath'));
  const pc = await api('/upwardbasketballscores/api/public/courts'); assert.equal(pc.status, 200); assert.ok(Array.isArray(pc.body)); assert.match(pc.type, /json/);
  for (const p of ['/schedule', '/upwardbasketballscores/schedule', '/nope', '/upwardbasketballscores/nope.js', '/court']) assert.equal((await page(p)).status, 404, p);
  const legacyWs = await open('court=west&role=tv', false, '/upwardbasketballscores/ws');
  assert.equal((await legacyWs.next((m) => m.type === 'state')).court.slug, 'west', 'legacy websocket path');
  await assert.rejects(open('court=west&role=tv', false, '/bogus'), 'other upgrade paths refused');
  for (const s of [score, tvFull, tvWest, ovFull, anon, sw, legacyWs]) s.ws.close();
});
