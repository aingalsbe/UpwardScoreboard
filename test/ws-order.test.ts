// QA B1 (Avery, fad2213): a scorekeeper's ws messages must be applied strictly in the order they were sent. The handler
// awaits 2–3 DB reads before it queues a command, and score.js flush() resends unacked taps in one burst, so back-to-back
// CLOCK_SET 30000 / 45000 could end at 30 s. This drives a real server + scratch DB over a real ws and never awaits acks
// between sends.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { WebSocket } from 'ws';
import type { ChildProcess } from 'node:child_process';
import { startServer } from './_server.js';

const BASE_URL = process.env.TEST_DATABASE_URL || '';
const skipDb = !BASE_URL ? 'TEST_DATABASE_URL not set' : !/test/i.test(new URL(BASE_URL).pathname) ? 'TEST_DATABASE_URL database name must contain "test"' : false;
let srv: ChildProcess | null = null;
after(() => { srv?.kill(); });

test('QA B1: back-to-back scorekeeper ws messages apply (and ack) strictly in arrival order', { skip: skipDb, timeout: 120_000 }, async () => {
  const u = new URL(BASE_URL); const name = u.pathname.slice(1) + '_wsorder'; u.pathname = '/' + name;
  const admin = new pg.Client({ connectionString: BASE_URL }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.query(`CREATE DATABASE "${name}"`); await admin.end();
  const started = await startServer({ DATABASE_URL: u.toString(), ADMIN_PASSWORD: 'b1-test', TZ: 'America/Chicago', SEED: 'true',
    COURT_PINS: 'full:1111,west:2222,east:3333', SESSION_SECRET: 'b1-test-secret-long-enough' });
  srv = started.srv;
  const BASE = `http://127.0.0.1:${started.port}`;
  const login = await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'b1-test' }) })).json() as any;
  const api = async (p: string, method = 'GET') => (await fetch(BASE + p, { method, headers: { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })).json() as Promise<any>;
  const games = await api('/api/games') as any[];
  const g = games.find((x) => x.court_slug === 'full' && x.full_court); assert.ok(g, 'a full court game');
  await api(`/api/games/${g.id}/start`, 'POST');

  // PIN-authed scorekeeper socket; the first command goes out right behind the auth message (also must stay in order).
  const ws = new WebSocket(`ws://127.0.0.1:${started.port}/ws?court=full&role=score`);
  const msgs: any[] = [];
  ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let n = 0;
  const send = (m: any) => { const id = `b1-${++n}`; ws.send(JSON.stringify({ ...m, id })); return id; };
  const settle = async (ids: string[], ms = 15_000) => {
    const t0 = Date.now();
    while (ids.some((id) => !msgs.some((m) => m.id === id && (m.type === 'ack' || m.type === 'error')))) {
      if (Date.now() - t0 > ms) throw new Error('timeout waiting on acks');
      await new Promise((r) => setTimeout(r, 5));
    }
    const replies = msgs.filter((m) => ids.includes(m.id) && (m.type === 'ack' || m.type === 'error'));
    for (const r of replies) assert.equal(r.type, 'ack', `${r.id}: ${r.error}`);
    return replies.map((r) => r.id).join() === ids.join(); // acks in send order?
  };
  const state = async () => (await (await fetch(`${BASE}/api/public/court/full`)).json() as any).game.state;

  ws.send(JSON.stringify({ type: 'auth', pin: '1111' }));
  await settle([send({ type: 'cmd', cmd: { type: 'CLOCK_SET', ms: 60_000 } })]);

  const problems: string[] = [];
  for (let it = 0; it < 30; it++) {
    // (a) Avery's repro, widened: a burst of CLOCK_SETs; the last one sent must win.
    const ids: string[] = []; let last = 0;
    for (let i = 0; i < 12; i++) { last = 30_000 + ((it * 12 + i) % 200) * 1000; ids.push(send({ type: 'cmd', cmd: { type: 'CLOCK_SET', ms: last } })); }
    // (b) mixed types: undo has fewer DB reads than a cmd, so it is the easiest to overtake with. +2, +3, undo => +2.
    const s0 = (await state()).home.score;
    ids.push(send({ type: 'cmd', cmd: { type: 'SCORE', team: 'home', pts: 2 } }));
    ids.push(send({ type: 'cmd', cmd: { type: 'SCORE', team: 'home', pts: 3 } }));
    ids.push(send({ type: 'undo' }));
    ids.push(send({ type: 'cmd', cmd: { type: 'CLOCK_SET', ms: last } }));
    let inOrder = false;
    try { inOrder = await settle(ids); } catch (e: any) { problems.push(`iter ${it}: ${e.message.split('\n')[0]}`); continue; }
    if (!inOrder) problems.push(`iter ${it}: acks not in send order`);
    const s = await state();
    if (s.clock.remainingMs !== last) problems.push(`iter ${it}: clock ${s.clock.remainingMs} != last sent ${last}`);
    if (s.home.score !== s0 + 2) problems.push(`iter ${it}: home ${s.home.score} != ${s0 + 2} (+2, +3, undo)`);
  }
  // An error in one message must not stall or reorder the rest: bad command, then two good ones, all unawaited.
  const bad = send({ type: 'cmd', cmd: { type: 'CLOCK_SET', ms: 'x' } });
  const g1 = send({ type: 'cmd', cmd: { type: 'CLOCK_SET', ms: 21_000 } });
  const g2 = send({ type: 'cmd', cmd: { type: 'CLOCK_SET', ms: 22_000 } });
  const t0 = Date.now();
  while (!msgs.some((m) => m.id === g2 && m.type === 'ack')) { if (Date.now() - t0 > 10_000) throw new Error('chain stalled after an error'); await new Promise((r) => setTimeout(r, 5)); }
  assert.equal(msgs.find((m) => m.id === bad)?.type, 'error', 'bad command refused');
  assert.equal(msgs.find((m) => m.id === g1)?.type, 'ack');
  const order = msgs.filter((m) => [bad, g1, g2].includes(m.id)).map((m) => m.id);
  assert.deepEqual(order, [bad, g1, g2], 'error reply and later acks keep send order');
  assert.equal((await state()).clock.remainingMs, 22_000, 'the chain kept going after the error');
  ws.close();
  assert.deepEqual(problems, [], `out-of-order application: ${problems.length} problem(s) over 30 iterations`);
});
