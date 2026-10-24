// End-to-end smoke test against a running server (default http://localhost:3000).
// Usage: ADMIN_PASSWORD=... PIN1=1111 PIN2=2222 node scripts/smoke.mjs
import { pinBrowserClock, nextSaturday } from './_gameday.mjs'; // first: shared game-day helper + test clock
import WebSocket from 'ws';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const WSB = BASE.replace(/^http/, 'ws');
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
// One gym floor: Full (full) or West (west) + East (east). PIN1 = west, PIN2 = east, PINF = full.
const PIN1 = process.env.PIN1 || '2222', PIN2 = process.env.PIN2 || '3333', PINF = process.env.PINF || '1111';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Repeatable on a used database: every name created here carries a per-run suffix, the games under
// test are created by this script, and lockouts use per-run device ids (admin-login lockout from a
// previous run is waited out via Retry-After).
const RUN = Date.now().toString(36).slice(-5);
const DEV = (n) => `smoke-${RUN}-${n}`;
let token;
async function api(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) } });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
}

function client(court, role) {
  const ws = new WebSocket(`${WSB}/ws?court=${court}&role=${role}`);
  const c = { ws, last: null, msgs: [], waiters: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)); c.msgs.push(m);
    if (m.type === 'state') c.last = m;
    c.waiters = c.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true));
  });
  c.wait = (pred, ms = 3000) => new Promise((res, rej) => {
    const hit = c.msgs.find(pred); if (hit) { c.msgs = c.msgs.filter((x) => x !== hit); return res(hit); }
    const w = { pred: (m) => { if (pred(m)) { c.msgs = c.msgs.filter((x) => x !== m); return true; } return false; }, res };
    c.waiters.push(w); setTimeout(() => rej(new Error('timeout waiting')), ms);
  });
  c.open = new Promise((r) => ws.on('open', r));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.cmd = (cmd, id = Math.random().toString(36).slice(2)) => { c.send({ type: 'cmd', id, cmd }); return c.wait((m) => (m.type === 'ack' || m.type === 'error') && m.id === id); };
  c.close = () => new Promise((r) => { ws.on('close', r); ws.close(); });
  return c;
}
const stateWhere = (pred) => (m) => m.type === 'state' && m.game && pred(m.game);
const remaining = (g, now) => (g.state.clock.running ? g.state.clock.remainingMs - (now - g.state.clock.startedAt) : g.state.clock.remainingMs);

console.log('1. Admin auth + start two games');
ok((await api('/api/teams')).status === 401, 'admin API rejects anonymous');
ok([401, 429].includes((await api('/api/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) })).status), 'wrong admin password rejected (401, or 429 if a previous run left it locked)');
for (let i = 0; i < 3 && !token; i++) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
  if (r.status === 429) { const w = Number(r.headers.get('retry-after') || 5); console.log(`  (admin login locked by a previous run; waiting ${w}s)`); await sleep(w * 1000 + 300); continue; }
  token = (await r.json()).token;
}
ok(!!token, 'admin login ok');
// One active game per court: complete whatever a previous run (or dev use) left active on the floor.
for (const g of (await api('/api/games')).body.filter((g) => g.status === 'active' && ['West', 'East', 'Full'].includes(g.court))) {
  await api(`/api/games/${g.id}/complete`, { method: 'POST' }); console.log(`  (completed leftover active game #${g.id} on ${g.court})`);
}
// Own fixtures: 4 teams + courts full/west/east (created if missing) + 2 games on west/east.
const T = {};
for (const [k, c1, c2] of [['A', '#7a1020', '#f2b705'], ['B', '#0d2c6b', '#4fc3f7'], ['C', '#14532d', '#a3e635'], ['D', '#4c1d95', '#f0abfc']]) {
  T[k] = { name: `Smoke${k}-${RUN}`, id: (await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: `Smoke${k}-${RUN}`, short_name: `S${k}`, primary_color: c1, secondary_color: c2 }) })).body.id };
}
let courtsNow = (await api('/api/courts')).body;
for (const [slug, name, conflicts_with] of [['full', 'Full', 'west east'], ['west', 'West', ''], ['east', 'East', '']]) if (!courtsNow.find((c) => c.slug === slug)) await api('/api/courts', { method: 'POST', body: JSON.stringify({ name, slug, conflicts_with }) });
courtsNow = (await api('/api/courts')).body;
const C1 = courtsNow.find((c) => c.slug === 'west'), C2 = courtsNow.find((c) => c.slug === 'east'), CF = courtsNow.find((c) => c.slug === 'full');
const mkGame = async (court, h, a) => {
  // a random future Fri/Sat morning (create follows the Fri/Sat + 08:00–21:00 game-hours rule): 14:00-16:59 UTC =
  // 08:00-11:59 Chicago (CST or CDT), whole minutes; avoids the DST fall-back hour and section 14's afternoon slots
  const day = new Date(); day.setUTCHours(14, 0, 0, 0); day.setUTCDate(day.getUTCDate() + ((5 - day.getUTCDay() + 7) % 7 || 7)); // next Friday
  const at = new Date(day.getTime() + (Math.floor(Math.random() * 120) * 7 + Math.floor(Math.random() * 2)) * 86_400_000 + Math.floor(Math.random() * 180) * 60_000).toISOString();
  const id = (await api('/api/games', { method: 'POST', body: JSON.stringify({ court_id: court.id, home_team_id: h.id, away_team_id: a.id, scheduled_at: at, division: `Smoke ${RUN}` }) })).body.id;
  return { id, home: h.name, away: a.name, home_team_id: h.id, away_team_id: a.id, court_id: court.id, scheduled_at: at };
};
const g1 = await mkGame(C1, T.A, T.B), g2 = await mkGame(C2, T.C, T.D);
const games = [g1, g2];
ok(g1.id && g2.id, `created games on both courts (#${g1.id} ${g1.home} v ${g1.away}, #${g2.id} ${g2.home} v ${g2.away})`);
ok((await api(`/api/games/${g1.id}/start`, { method: 'POST' })).body.court === 'west', 'started game on west');
ok((await api(`/api/games/${g2.id}/start`, { method: 'POST' })).body.court === 'east', 'started game on east');

console.log('2. Connect TVs and controllers');
const tv1 = client('west', 'tv'), tv2 = client('east', 'tv');
const sk1 = client('west', 'score'), sk2 = client('east', 'score');
await Promise.all([tv1.open, tv2.open, sk1.open, sk2.open]);
const s1 = await tv1.wait(stateWhere((g) => g.id === g1.id));
ok(s1.game.home.name === g1.home && s1.game.home.color.startsWith('#'), `TV1 got snapshot: ${s1.game.home.name} (${s1.game.home.color}) vs ${s1.game.away.name}`);
const r0 = await tv1.cmd({ type: 'SCORE', team: 'home', pts: 2 });
ok(r0.type === 'error' && /read-only/.test(r0.error), 'TV (public) cannot send commands');
sk1.send({ type: 'auth', pin: '0000', device: DEV('sk1') });
ok((await sk1.wait((m) => m.type === 'auth')).ok === false, 'wrong PIN rejected');
sk1.send({ type: 'auth', pin: PIN2, device: DEV('sk1') });
ok((await sk1.wait((m) => m.type === 'auth')).ok === false, "east PIN doesn't unlock west");
sk1.send({ type: 'auth', pin: PIN1, device: DEV('c1') }); ok((await sk1.wait((m) => m.type === 'auth')).ok, 'west PIN accepted');
sk2.send({ type: 'auth', pin: PIN2, device: DEV('c2') }); ok((await sk2.wait((m) => m.type === 'auth')).ok, 'east PIN accepted');

console.log('3. Score change on controller shows on the right TV only');
const base1 = (await api('/api/public/court/west')).body.game.state;
const base2 = (await api('/api/public/court/east')).body.game.state;
tv1.msgs = []; tv2.msgs = [];
let t0 = Date.now();
const a1 = await sk1.cmd({ type: 'SCORE', team: 'home', pts: 2 });
ok(a1.type === 'ack', `controller ack seq=${a1.seq}`);
const u1 = await tv1.wait(stateWhere((g) => g.state.seq === a1.seq));
ok(u1.game.state.home.score === base1.home.score + 2, `TV1 shows home ${u1.game.state.home.score} (latency ${Date.now() - t0} ms)`);
await sleep(300);
ok(!tv2.msgs.some((m) => m.type === 'state' && m.game?.state.home.score !== base2.home.score), 'TV2 unaffected by west change');
const a2 = await sk2.cmd({ type: 'SCORE', team: 'away', pts: 3 });
const u2 = await tv2.wait(stateWhere((g) => g.state.seq === a2.seq));
ok(u2.game.state.away.score === base2.away.score + 3, `TV2 shows away ${u2.game.state.away.score} (two courts at once)`);
await sk1.cmd({ type: 'FOUL', team: 'away', delta: 1 });
await sk1.cmd({ type: 'POSSESSION', team: 'toggle' });

console.log('4. Clock runs from server timestamps; TV reconnect resyncs exact state');
await sk1.cmd({ type: 'CLOCK_SET', ms: 5 * 60_000 });
const st = await sk1.cmd({ type: 'CLOCK_START' });
ok(st.type === 'ack', 'clock started');
await sleep(1500);
await tv1.close();
await sleep(500); // TV "dropped" while the game goes on
const ax = await sk1.cmd({ type: 'SCORE', team: 'away', pts: 1 });
const tv1b = client('west', 'tv'); await tv1b.open;
const snap = await tv1b.wait(stateWhere((g) => g.id === g1.id));
const now = snap.serverNow;
ok(snap.game.state.seq === ax.seq, `reconnected TV has latest seq ${snap.game.state.seq} (missed update included)`);
const rem = remaining(snap.game, now);
ok(rem <= 5 * 60_000 - 1900 && rem >= 5 * 60_000 - 3000, `clock after ~2s running = ${(rem / 1000).toFixed(1)}s (expected ~298s)`);
ok(snap.game.state.clock.running === true, 'clock still running after TV reconnect');

console.log('5. Controller refresh restores state; retries are idempotent');
await sk1.close();
const sk1b = client('west', 'score'); await sk1b.open;
sk1b.send({ type: 'auth', pin: PIN1, device: DEV('c1') }); await sk1b.wait((m) => m.type === 'auth' && m.ok);
const cs = await sk1b.wait(stateWhere((g) => g.id === g1.id));
ok(cs.game.state.seq === ax.seq && cs.game.state.away.fouls >= 1, 'refreshed controller sees exact server state');
const dupId = 'retry-123-' + Date.now();
const d1 = await sk1b.cmd({ type: 'SCORE', team: 'home', pts: 3 }, dupId);
const d2 = await sk1b.cmd({ type: 'SCORE', team: 'home', pts: 3 }, dupId);
ok(d2.dup === true && d2.seq === d1.seq, 'resent command with same id applied once');

console.log('6. Undo / redo');
const before = (await api('/api/public/court/west')).body.game.state.home.score;
const un = await (async () => { const id = 'u' + Date.now(); sk1b.send({ type: 'undo', id }); return sk1b.wait((m) => m.type === 'ack' && m.id === id); })();
const afterUndo = await tv1b.wait(stateWhere((g) => g.state.seq === un.seq));
ok(afterUndo.game.state.home.score === before - 3, `undo reverted +3 (${before} -> ${afterUndo.game.state.home.score}) on the TV`);
ok(afterUndo.game.state.clock.running === true, 'undo did not stop the running clock');
const re = await (async () => { const id = 'r' + Date.now(); sk1b.send({ type: 'redo', id }); return sk1b.wait((m) => m.type === 'ack' && m.id === id); })();
const afterRedo = await tv1b.wait(stateWhere((g) => g.state.seq === re.seq));
ok(afterRedo.game.state.home.score === before, 'redo re-applied it');

console.log('7. Two controllers on one game');
const sk1c = client('west', 'score'); await sk1c.open;
sk1c.send({ type: 'auth', pin: PIN1, device: DEV('c1') }); await sk1c.wait((m) => m.type === 'auth' && m.ok);
const pres = await tv1b.wait((m) => m.type === 'state' && m.presence?.controllers === 2);
ok(!!pres, 'presence shows 2 scorekeepers connected');
const pre = (await api('/api/public/court/west')).body.game.state.home.score;
const [x, y] = await Promise.all([sk1b.cmd({ type: 'SCORE', team: 'home', pts: 1 }), sk1c.cmd({ type: 'SCORE', team: 'home', pts: 1 })]);
ok(x.seq !== y.seq, `simultaneous taps serialized (seq ${x.seq}, ${y.seq})`);
const fin = (await api('/api/public/court/west')).body.game.state;
ok(fin.home.score === pre + 2, `both applied: ${pre} -> ${fin.home.score}`);
await sk1b.cmd({ type: 'CLOCK_STOP' });

console.log('8. CSV export / import');
const tcsv = await fetch(BASE + '/api/export/teams.csv', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
ok(tcsv.startsWith('name,short_name,grade,gender,coach,logo_url') && /SmokeA-/.test(tcsv), 'teams.csv exported (name, short_name, grade, gender, coach, logo_url; no team colors)');
const imp = await api('/api/import/teams.csv', { method: 'POST', body: `name,short_name,primary_color,secondary_color,logo_url\r\nCru-${RUN},CRU,#003366,#ffd700,\r\n"${T.C.name}",SC2,#14532d,#a3e635,\r\n` });
ok(imp.body.created === 1 && imp.body.updated === 1 && imp.body.errors.length === 0, `teams.csv imported (created ${imp.body.created}, updated ${imp.body.updated})`);
// B1 (Avery r20): a guaranteed-free Saturday for the import. A fixed date collided with the demo seed on a real
// Fri/Sat; take the first Saturday from 3 weeks out (game-day helper) with no game at all, on any court.
const gameDates = new Set((await api('/api/games')).body.map((g) => g.scheduled_at && new Date(g.scheduled_at).toLocaleDateString('sv-SE', { timeZone: 'America/Chicago' })));
let IMP_DATE = null;
for (let w = 3; w < 60 && !IMP_DATE; w++) { const d = nextSaturday('09:30', w).toLocaleDateString('sv-SE', { timeZone: 'America/Chicago' }); if (!gameDates.has(d)) IMP_DATE = d; }
const simp = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,division,home,away\n${IMP_DATE},09:30,east,3rd-4th Grade,Cru-${RUN},${T.B.name}\n${IMP_DATE},10:30,west,5th-6th Grade,Nobodies-${RUN},${T.A.name}\n` });
ok(simp.body.created === 1 && simp.body.errors.length === 1, `schedule.csv imported 1 row on free Saturday ${IMP_DATE}, bad row reported: "${simp.body.errors[0]}"`);
const scsv = await fetch(BASE + '/api/export/schedule.csv', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
ok(/^id,date,time,court,division,home,away,home_score,away_score,status/.test(scsv) && new RegExp(`\\d+,${IMP_DATE},09:30,east,3rd-4th Grade,Cru-${RUN},${T.B.name}`).test(scsv), 'schedule.csv export (with id column) round-trips the import');

const cimp = await api('/api/import/courts.csv', { method: 'POST', body: `slug,name,location\nsmk-${RUN},Smoke court ${RUN},Annex\n` });
ok(cimp.body.created === 1 && cimp.body.errors.length === 0, 'courts.csv imported (upsert by slug)');
const ccsv = await fetch(BASE + '/api/export/courts.csv', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
ok(ccsv.startsWith('slug,name,location') && new RegExp(`smk-${RUN},Smoke court ${RUN},Annex`).test(ccsv), 'courts.csv export round-trips');
await api(`/api/courts/${(await api('/api/courts')).body.find((c) => c.slug === `smk-${RUN}`).id}`, { method: 'DELETE' });


console.log('9. Idempotent re-import (QA #2)');
const auth = { authorization: `Bearer ${token}` };
const countGames = async () => (await api('/api/games')).body.length;
const exp = await fetch(BASE + '/api/export/schedule.csv', { headers: auth }).then((r) => r.text());
const n0 = await countGames();
const re1 = await api('/api/import/schedule.csv', { method: 'POST', body: exp });
ok(re1.body.created === 0 && re1.body.updated === 0 && re1.body.skipped === n0 && (await countGames()) === n0, `re-importing the export changes nothing (${n0} games, skipped ${re1.body.skipped}${re1.body.errors.length ? " " + JSON.stringify(re1.body.errors) : ""})`);
const dupFile = `date,time,court,division,home,away\n2026-11-07,09:00,west,Dup test,${T.A.name},${T.B.name}\n2026-11-07,09:00,west,Dup test,${T.A.name},${T.B.name}\n`;
const d1i = await api('/api/import/schedule.csv', { method: 'POST', body: dupFile });
ok(d1i.body.created === 1 && d1i.body.skipped === 1, `duplicate rows within one file: created ${d1i.body.created}, skipped ${d1i.body.skipped}`);
const d2i = await api('/api/import/schedule.csv', { method: 'POST', body: dupFile });
ok(d2i.body.created === 0 && d2i.body.skipped === 2 && (await countGames()) === n0 + 1, 'importing the same file twice does not duplicate');
const upd = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,division,home,away\n2026-11-07,09:00,west,Renamed ${RUN},${T.A.name},${T.B.name}\n` });
ok(upd.body.updated === 1 && upd.body.created === 0, 'natural-key match updates the division instead of adding a game');
const gid = (await api('/api/games')).body.find((g) => g.division === `Renamed ${RUN}`).id;
const byId = await api('/api/import/schedule.csv', { method: 'POST', body: `id,date,time,court,division,home,away\n${gid},2026-11-07,10:00,east,Renamed ${RUN},${T.A.name},${T.B.name}\n` });
ok(byId.body.updated === 1 && (await countGames()) === n0 + 1, 'exported id column moves the game (time/court change) without duplicating');
const nd = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,division,home,away\n,,,TBD ${RUN},${T.C.name},${T.D.name}\n` });
ok(nd.body.created === 1 && nd.body.errors.length === 0, 'r2-B: a game with no date/time/court imports (not scheduled yet)');
const exp2 = await fetch(BASE + '/api/export/schedule.csv', { headers: auth }).then((r) => r.text());
const ndLine = exp2.split(/\r?\n/).find((l) => l.includes(`TBD ${RUN}`));
ok(/^\d+,,,,TBD /.test(ndLine || ''), `r2-B: exported with empty date/time/court: ${ndLine}`);
const re2 = await api('/api/import/schedule.csv', { method: 'POST', body: exp2 });
ok(re2.body.created === 0 && re2.body.updated === 0 && re2.body.errors.length === 0, `r2-B: full export incl. undated game re-imports cleanly (skipped ${re2.body.skipped} ${JSON.stringify(re2.body.errors).slice(0,300)} c${re2.body.created} u${re2.body.updated})`);
const g1Live = (await api('/api/public/court/west')).body.game.state;
const g1Line = exp2.split(/\r?\n/).find((l) => l.startsWith(g1.id + ','));
ok(g1Line && g1Line.includes(`,${g1Live.home.score},${g1Live.away.score},active,`), `#8: export carries the live score of an in-progress game (${g1Line})`);
const tAgain = await api('/api/import/teams.csv', { method: 'POST', body: tcsv });
ok(tAgain.body.created === 0 && tAgain.body.errors.length === 0, `teams re-import idempotent (created 0, skipped ${tAgain.body.skipped})`);
const ccsv2 = await fetch(BASE + '/api/export/courts.csv', { headers: auth }).then((r) => r.text());
const cAgain = await api('/api/import/courts.csv', { method: 'POST', body: ccsv2 });
ok(cAgain.body.created === 0 && cAgain.body.updated === 0, 'courts re-import idempotent');
const dupGame = await api('/api/games', { method: 'POST', body: JSON.stringify({ court_id: g1.court_id, home_team_id: g1.home_team_id, away_team_id: g1.away_team_id, scheduled_at: games.find((g) => g.id === g1.id).scheduled_at }) });
ok(dupGame.status === 409 && new RegExp(`already in use: game #${g1.id}|already scheduled`).test(dupGame.body.error), `admin double-add -> 409 "${dupGame.body.error}"`);

console.log('10. Explicit CSV errors (QA #8)');
const badColor = await api('/api/import/teams.csv', { method: 'POST', body: `name,short_name,primary_color,secondary_color,logo_url\nPurples-${RUN},PUR,purple,#ffffff,\n` });
ok(badColor.body.created === 1 && badColor.body.errors.length === 0 && /primary_color and secondary_color ignored: every team uses the season colors/.test((badColor.body.warnings || []).join(' ')), `old teams.csv with color columns still imports, colors ignored with a note: "${(badColor.body.warnings || [])[0]}"`);
const badUrl = await api('/api/import/teams.csv', { method: 'POST', body: 'name,logo_url\nXSS,javascript:alert(1)\n' });
ok(badUrl.body.created === 0 && /http/.test(badUrl.body.errors[0]), `javascript: logo URL rejected: ${badUrl.body.errors[0]}`);
const missing = await api('/api/import/schedule.csv', { method: 'POST', body: 'date,court,home,away\n2026-11-07,west,Lions,Eagles\n' });
ok(missing.status === 400 && /missing required column\(s\): time/.test(missing.body.error), `missing column -> 400: ${missing.body.error}`);
const courtsBefore = (await api('/api/courts')).body.length;
const unk = await api('/api/import/schedule.csv', { method: 'POST', body: 'date,time,court,division,home,away\n2026-11-07,09:00,court-77,X,Lions,Eagles\n' });
ok(unk.body.created === 0 && /unknown court "court-77"/.test(unk.body.errors[0]) && (await api('/api/courts')).body.length === courtsBefore, 'unknown court slug -> row error, no court auto-created');
const badDate = await api('/api/import/schedule.csv', { method: 'POST', body: 'date,time,court,division,home,away\n10/24/2026,9am,west,X,Lions,Eagles\n' });
ok(/must be YYYY-MM-DD/.test(badDate.body.errors[0]), 'bad date format -> row error');

console.log('11. Logos and delete (QA #4, #9, #10)');
const big = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2_300_000)]).toString('base64');
const r413 = await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'Bigs', logo_data_url: big }) });
ok(r413.status === 413 && /1 MB/.test(r413.body.error), `2.3 MB logo -> 413 "${r413.body.error}"`);
ok((await api('/api/health')).status === 200, 'server still healthy after oversized upload');
const svg = await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'Svgs', logo_data_url: 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64') }) });
ok(svg.status === 415 && /SVG/.test(svg.body.error), 'SVG logo rejected (415)');
const fake = await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'Fakes', logo_data_url: 'data:image/png;base64,' + Buffer.from('<html>hi</html>').toString('base64') }) });
ok(fake.status === 415, 'non-image bytes labeled image/png rejected (magic bytes)');
const tiny = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
ok((await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: `Realpng-${RUN}`, logo_data_url: tiny }) })).status === 201, 'real PNG accepted');
const jsUrl = await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'Jsurl', logo_url: 'javascript:alert(1)' }) });
ok(jsUrl.status === 400, 'javascript: logo URL rejected (400)');
const del = await api(`/api/teams/${T.A.id}`, { method: 'DELETE' });
ok(del.status === 409 && new RegExp(`${T.A.name}" is in \\d+ games?`).test(del.body.error), `delete team with games -> 409 "${del.body.error}"`);

console.log('12. Brute-force protection (QA #3, r2-A/D): per court + device, sessions, displays never count');
const brute = client('east', 'score'); await brute.open;
const closed = new Promise((r) => brute.ws.on('close', (code) => r(code)));
let lastB;
for (let i = 0; i < 5; i++) { brute.send({ type: 'auth', pin: String(9000 + i), device: DEV('brute') }); lastB = await brute.wait((m) => m.type === 'auth' && (m.locked || /Wrong PIN/.test(m.error))); }
ok(lastB.locked === true && lastB.retryAfter > 0, `5 wrong PINs on one device -> locked with countdown ${lastB.retryAfter}s`);
ok((await closed) === 4008, 'socket closed after 5 wrong PINs (code 4008)');
const brute2 = client('east', 'score'); await brute2.open;
brute2.send({ type: 'auth', pin: PIN2, device: DEV('brute') });
const lockedOk = await brute2.wait((m) => m.type === 'auth');
ok(lockedOk.ok === false && lockedOk.locked, 'that device is refused even with the correct PIN while locked');
const other = client('east', 'score'); await other.open;
other.send({ type: 'auth', pin: PIN2, device: DEV('other') });
ok((await other.wait((m) => m.type === 'auth')).ok === true, 'a different device on the same IP and court still signs in (no whole-gym lockout)');
const tvA = client('west', 'tv'); await tvA.open;
for (let i = 0; i < 20; i++) tvA.send({ type: 'auth', pin: String(i), device: DEV('tv') });
tvA.send({ type: 'auth', pin: PIN1, device: DEV('tv') });
await sleep(300);
const tvAuths = tvA.msgs.filter((m) => m.type === 'auth');
ok(tvAuths.length === 21 && tvAuths.every((m) => !m.ok && !m.locked) && tvA.ws.readyState === 1, '21 auth attempts from a TV: refused as read-only, never counted, socket stays open');
let l429;
for (let i = 0; i < 6; i++) l429 = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'guess' + i }) });
ok(l429.status === 429 && Number(l429.headers.get('retry-after')) > 0, `admin login: 429 with Retry-After ${l429.headers.get('retry-after')}s after 5 failures`);
const good = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
ok(good.status === 429, 'correct admin password also refused during lockout (next run waits it out)');

console.log('13. QA r2-A scenario: west signed in, east guesses, west blips, queued tap goes through');
const ph = client('west', 'score'); await ph.open;
ph.send({ type: 'auth', pin: PIN1, device: DEV('phone1') });
const sa0 = await ph.wait((m) => m.type === 'auth');
ok(sa0.ok && typeof sa0.session === 'string', 'west phone signs in with PIN and receives a court session token');
for (let d = 0; d < 3; d++) { // 15 wrong PINs from 3 east devices on the same IP (old code locked the whole IP after 10)
  const k = client('east', 'score'); await k.open;
  for (let i = 0; i < 5; i++) { k.send({ type: 'auth', pin: String(7000 + d * 10 + i), device: DEV('kid' + d) }); await k.wait((m) => m.type === 'auth').catch(() => {}); }
}
const before13 = (await api('/api/public/court/west')).body.game.state.home.score;
ph.ws.terminate(); // Wi-Fi blip
const ph2 = client('west', 'score'); await ph2.open;
const qid = 'queued-' + RUN;
ph2.send({ type: 'cmd', id: qid, gameId: g1.id, cmd: { type: 'SCORE', team: 'home', pts: 2 } }); // tap queued before re-auth
const refused = await ph2.wait((m) => m.id === qid);
ok(refused.type === 'error' && /PIN required/.test(refused.error), 'tap sent before re-auth is refused (client keeps it queued)');
ph2.send({ type: 'auth', session: sa0.session, device: DEV('phone1') });
const sa2 = await ph2.wait((m) => m.type === 'auth');
ok(sa2.ok && sa2.how === 'session', 'reconnect re-authenticates with the session token (no PIN, not affected by the lockout)');
ph2.send({ type: 'cmd', id: qid, gameId: g1.id, cmd: { type: 'SCORE', team: 'home', pts: 2 } }); // client retry
const acked = await ph2.wait((m) => m.type === 'ack' && m.id === qid);
const after13 = (await api('/api/public/court/west')).body.game.state.home.score;
ok(acked && after13 === before13 + 2, `queued tap applied exactly once (${before13} -> ${after13})`);
const ph3 = client('west', 'score'); await ph3.open;
ph3.send({ type: 'auth', session: sa0.session.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) });
ok((await ph3.wait((m) => m.type === 'auth')).needPin === true, 'a tampered session token is refused (asks for the PIN)');
const ph4 = client('east', 'score'); await ph4.open;
ph4.send({ type: 'auth', session: sa0.session });
ok((await ph4.wait((m) => m.type === 'auth')).ok === false, 'a west session does not unlock east');
for (const c of [brute2, other, tvA, ph2, ph3, ph4]) c.ws.close();

console.log('14. Shared floor: Full cannot overlap West or East; West and East can overlap');
const local = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).slice(0, 16).split(' '); // [date, HH:MM]
// A random future Saturday (plain edits that move a game follow the Fri/Sat + 08:00–21:00 game-hours rules)
const D = (() => { const d = new Date(); d.setUTCHours(21, 0, 0, 0); d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7)); return d.getTime() + Math.floor(Math.random() * 128) * 7 * 86_400_000; })(); // Sat ~15:00-16:00 Chicago
const iso = (ms) => new Date(ms).toISOString();
const made = [];
const post = async (court, h, a, ms, extra = {}) => { const r = await api('/api/games', { method: 'POST', body: JSON.stringify({ court_id: court.id, home_team_id: h.id, away_team_id: a.id, scheduled_at: iso(ms), division: `Floor ${RUN}`, ...extra }) }); if (r.body.id) made.push(r.body.id); return r; };
const w = await post(C1, T.A, T.B, D);
const e = await post(C2, T.C, T.D, D);
ok(w.status === 201 && e.status === 201, 'West and East games at the same time are allowed');
const f1 = await post(CF, T.C, T.B, D + 30 * 60_000);
ok(f1.status === 409 && new RegExp(`game #(${w.body.id}|${e.body.id}) on (West|East)`).test(f1.body.error), `admin create on Full overlapping West/East -> 409 "${f1.body.error}"`);
const f2 = await post(CF, T.C, T.B, D + 60 * 60_000);
ok(f2.status === 201, 'Full back-to-back right after West/East (start + 60 min) is allowed');
const mv = await api(`/api/games/${f2.body.id}`, { method: 'PUT', body: JSON.stringify({ scheduled_at: iso(D + 15 * 60_000) }) });
ok(mv.status === 409 && /Can't move: overlaps game #/.test(mv.body.error), `admin edit (move) into an overlap -> 409 "${mv.body.error}"`);
const longW = await post(C1, T.D, T.A, D - 120 * 60_000, { duration_min: 190 });
ok(longW.status === 409 && new RegExp(`game #${f2.body.id} on Full`).test(longW.body.error), `West game whose length (190 min) runs into a Full game is refused -> "${longW.body.error}"`);
const [fd, ft] = local(D + 15 * 60_000), [wd, wt] = local(D + 60 * 60_000), [pd, pt] = local(D - 150 * 60_000);
const ci = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,division,home,away\n${fd},${ft},full,Floor ${RUN},${T.D.name},${T.A.name}\n${wd},${wt},west,Floor ${RUN},${T.D.name},${T.B.name}\n` });
ok(ci.body.created === 0 && ci.body.errors.length === 2 && /row 2: \S+ \S+: overlaps game #\d+ on (West|East)/.test(ci.body.errors[0]) && new RegExp(`row 3: \\S+ \\S+: overlaps game #${f2.body.id} on Full`).test(ci.body.errors[1]),
  `CSV import: overlap is a row error naming the other game (both directions): ${JSON.stringify(ci.body.errors)}`);
const m1 = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,division,home,away,minutes\n${pd},${pt},full,Floor ${RUN},${T.A.name},${T.C.name},120\n` });
ok(m1.body.created === 1 && m1.body.errors.length === 0, 'CSV minutes column: a 120-min Full game ending 30 min before West/East is accepted');
const m2 = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,division,home,away,minutes\n${pd},${pt},full,Floor ${RUN},${T.A.name},${T.C.name},180\n` });
ok(m2.body.updated === 0 && /overlaps game #/.test(m2.body.errors[0] || ''), `...and lengthening it to 180 min is refused: "${m2.body.errors[0]}"`);
made.push(...(await api('/api/games')).body.filter((g) => g.division === `Floor ${RUN}` && !made.includes(g.id)).map((g) => g.id));
const st1 = await api(`/api/games/${f2.body.id}/start`, { method: 'POST' });
ok(st1.status === 409 && /(West|East) is live/.test(st1.body.error), `starting Full while West/East is live -> 409 "${st1.body.error}"`);
const st2 = await api(`/api/games/${f2.body.id}/start`, { method: 'POST', body: JSON.stringify({ force: true }) });
ok(st2.status === 200 && st2.body.court === 'full', 'admin can override ("Start anyway")');
const st3 = await api(`/api/games/${w.body.id}/start`, { method: 'POST' });
ok(st3.status === 409 && /Full is live/.test(st3.body.error), `and the reverse: starting West while Full is live -> 409 "${st3.body.error}"`);
for (const id of made) await api(`/api/games/${id}`, { method: 'DELETE' }); // leave the floor as it was (repeatable)
ok(!(await api('/api/courts')).body.find((c) => c.slug === 'full').current_game_id, 'floor-test games removed; Full is free again');

console.log('15. Church branding, season colors, cheer squads, grades');
const pubW = (await api('/api/public/court/west')).body;
ok(pubW.church?.name === 'Lenexa Baptist Church' && /Lenexa Baptist Church/.test(pubW.league), `TV header branding: "${pubW.church?.name}" / "${pubW.league}"`);
const seasonNow = (await api('/api/settings/season')).body;
ok(/^#[0-9A-F]{6}$/.test(seasonNow.dark) && /^#[0-9A-F]{6}$/.test(seasonNow.light), `season colors: ${seasonNow.name} dark ${seasonNow.dark} light ${seasonNow.light}`);
const gW = pubW.game;
ok(gW.homeSide === 'light' && gW.home.color === seasonNow.light && gW.away.color === seasonNow.dark && gW.home.accent === seasonNow.dark, 'default: home wears light, away wears dark (season colors, not team colors)');
const badSeason = await api('/api/settings/season', { method: 'PUT', body: JSON.stringify({ dark: seasonNow.light, light: seasonNow.dark }) });
ok(badSeason.status === 400 && /darker/.test(badSeason.body.error), `season with dark lighter than light -> 400 "${badSeason.body.error}"`);
const putSeason = await api('/api/settings/season', { method: 'PUT', body: JSON.stringify(seasonNow) });
ok(putSeason.status === 200 && putSeason.body.dark === seasonNow.dark, 'season colors save (restored to the same values)');
// cheer + swap via admin edit on the live west game
const tvC = client('west', 'tv'), skC = client('west', 'score'); await Promise.all([tvC.open, skC.open]);
skC.send({ type: 'auth', pin: PIN1, device: DEV('cheer') }); await skC.wait((m) => m.type === 'auth' && m.ok);
tvC.msgs = []; skC.msgs = [];
const ed1 = await api(`/api/games/${g1.id}`, { method: 'PUT', body: JSON.stringify({ swap_colors: true, cheer: `Cheer ${RUN}`, cheer_logo_url: 'https://example.org/c.png' }) });
ok(ed1.status === 200, 'admin edit: swap colors + the game\'s cheer squad');
const tvS = await tvC.wait((m) => m.type === 'state' && m.game?.cheer?.name === `Cheer ${RUN}`);
ok(tvS.game.homeSide === 'dark' && tvS.game.swapped === true && tvS.game.home.color === seasonNow.dark && tvS.game.cheer.logo === 'https://example.org/c.png' && !('cheer' in tvS.game.home) && !('cheer' in tvS.game.away), 'TV gets the swap (home dark) and the cheer squad of the game\'s time slot + logo; away has none');
const skS = await skC.wait((m) => m.type === 'state' && m.game?.homeSide === 'dark');
ok(!('cheer' in skS.game) && !('cheer' in skS.game.home) && !JSON.stringify(skS).includes(`Cheer ${RUN}`), 'scorekeeper never receives cheer squad data (but does get homeSide)');
const badLogo = await api(`/api/games/${g1.id}`, { method: 'PUT', body: JSON.stringify({ cheer: 'X', cheer_logo_data_url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }) });
ok(badLogo.status >= 400 && badLogo.status < 500 && (await api(`/api/games`)).body.find((g) => g.id === g1.id).cheer === `Cheer ${RUN}`, `cheer logo uses team-logo validation (SVG refused, nothing saved): "${badLogo.body.error}"`);
const exp3 = await fetch(BASE + '/api/export/schedule.csv', { headers: auth }).then((r) => r.text());
const hdr = exp3.split(/\r?\n/)[0];
const line3 = exp3.split(/\r?\n/).find((l) => l.startsWith(g1.id + ','));
ok(hdr.endsWith('minutes,grade,gender,swap_colors,home_locker,away_locker,moved_from_date,moved_from_time') && line3.endsWith(',true,,,,'), `export carries swap + locker + read-only moved_from columns; cheer moved to cheer_slots.csv (${line3})`);
const slots3 = await fetch(BASE + '/api/export/cheer_slots.csv', { headers: auth }).then((r) => r.text());
ok(slots3.includes(`,Cheer ${RUN},`), 'cheer_slots.csv export lists the slot the admin edit set');
// Only this run's game: other games (e.g. the demo seed) reuse names across grades and need the grade column.
const old = await api('/api/import/schedule.csv', { method: 'POST', body: [hdr, line3].map((l) => l.split(',').slice(0, 7).join(',')).join('\n') });
const g1After = (await api('/api/games')).body.find((g) => g.id === g1.id);
ok(old.body.errors.length === 0 && old.body.created === 0 && g1After.cheer === `Cheer ${RUN}` && g1After.swap_colors === true, 'old-format schedule CSV (no new columns) still imports and keeps cheer/swap');
const reX = await api('/api/import/schedule.csv', { method: 'POST', body: exp3 });
ok(reX.body.created === 0 && reX.body.updated === 0 && reX.body.errors.length === 0, `full export with new columns re-imports unchanged (skipped ${reX.body.skipped})`);
const clr = await api('/api/import/schedule.csv', { method: 'POST', body: `id,date,time,court,home,away,swap_colors,cheer\n${line3.split(',').slice(0, 4).join(',')},${T.A.name},${T.B.name},,\n` });
let g1Clr = (await api('/api/games')).body.find((g) => g.id === g1.id);
ok(clr.body.updated === 1 && g1Clr.swap_colors === false && g1Clr.cheer === `Cheer ${RUN}`, 'CSV with empty swap_colors clears it; a blank legacy cheer cell does not clear the shared time slot');
const [cd3, ct3] = line3.split(',').slice(1, 3);
const clrSlot = await api('/api/import/cheer_slots.csv', { method: 'POST', body: `date,time,squad,locker\n${cd3},${ct3},,\n` });
g1Clr = (await api('/api/games')).body.find((g) => g.id === g1.id);
ok(clrSlot.body.updated === 1 && g1Clr.cheer === null, 'cheer_slots.csv with a blank squad removes the cheer for that hour');
tvC.ws.close(); skC.ws.close();
// grades
const mk = async (name, grade) => (await api('/api/teams', { method: 'POST', body: JSON.stringify({ name, grade }) })).body.id;
const G5a = await mk(`G5a-${RUN}`, '5th'), G5b = await mk(`G5b-${RUN}`, '5th grade'), G2 = await mk(`G2-${RUN}`, '2nd Grade');
const tl = (await api('/api/teams')).body;
ok(tl.find((t) => t.id === G5a).grade === '5th-6th Grade' && tl.find((t) => t.id === G5b).grade === '5th-6th Grade', 'grade labels normalized ("5th", "5th grade" -> "5th-6th Grade")');
const ord = tl.filter((t) => [G5a, G5b, G2].includes(t.id)).map((t) => t.id);
ok(ord[0] === G2 && ord[1] === G5a && ord[2] === G5b, 'teams list sorted by grade, then name');
const gm = await api('/api/games', { method: 'POST', body: JSON.stringify({ court_id: C2.id, home_team_id: G5a, away_team_id: G2 }) });
ok(gm.status === 400 && /within one grade: G5a-\w+ is 5th-6th Grade, G2-\w+ is 1st-2nd Grade/.test(gm.body.error), `admin: cross-grade game -> 400 "${gm.body.error}"`);
const gi = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,grade,home,away\n,,,,G5a-${RUN},G2-${RUN}\n,,,4th Grade,G5a-${RUN},G5b-${RUN}\n,,,5th Grade,G5a-${RUN},G5b-${RUN}\n` });
ok(gi.body.created === 1 && /row 2: a game must be within one grade/.test(gi.body.errors[0]) && /row 3: grade "3rd-4th Grade" doesn't match the teams \(5th-6th Grade\)/.test(gi.body.errors[1]), `CSV: grade mismatch rows rejected, matching row imported: ${JSON.stringify(gi.body.errors)}`);
const gg = (await api('/api/games')).body.find((g) => g.home_team_id === G5a && g.away_team_id === G5b);
ok(gg?.grade === '5th-6th Grade', 'games list carries the grade');
const tcsv2 = await fetch(BASE + '/api/export/teams.csv', { headers: auth }).then((r) => r.text());
ok(new RegExp(`G5a-${RUN},G5A,5th-6th Grade,`).test(tcsv2), 'teams.csv export includes grade');
const oldT = await api('/api/import/teams.csv', { method: 'POST', body: `name,short_name,logo_url\nG5a-${RUN},G5A,\n` });
ok(oldT.body.errors.length === 0 && (await api('/api/teams')).body.find((t) => t.id === G5a).grade === '5th-6th Grade', 'old teams.csv without a grade column keeps the grade');
await api(`/api/games/${gg.id}`, { method: 'DELETE' });

console.log('16. Scorekeeping flow: weekly QR, pick a game, one active game, complete locks, resume, TV routes, status export');
const fc = (await api('/api/courts', { method: 'POST', body: JSON.stringify({ name: `Flow ${RUN}`, slug: `flow-${RUN}` }) })).body; // own court, no PIN: QR only
const qrs = (await api('/api/qr')).body; const q1 = qrs.find((q) => q.slug === fc.slug);
const tok1 = new URL(q1.url).searchParams.get('t');
ok(q1 && q1.svg.startsWith('<svg') && new URL(q1.url).pathname === `/score/${fc.slug}` && Date.parse(q1.expires) > Date.now(), `Admin QR: SVG + /score/${fc.slug}?t=… valid until ${q1.expires}`);
ok(new Date(q1.expires).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).startsWith('Sun') && /23:59/.test(new Date(q1.expires).toLocaleString('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23' })), 'QR expires Sunday 23:59 America/Chicago');
const fk = client(fc.slug, 'score'); await fk.open;
fk.send({ type: 'auth', qr: tok1, device: DEV('qr1') });
let qa = await fk.wait((m) => m.type === 'auth');
ok(qa.ok && qa.how === 'qr' && typeof qa.session === 'string', 'scanning the QR signs in and returns the 12 h device session');
const fk0 = client('west', 'score'); await fk0.open;
fk0.send({ type: 'auth', qr: tok1, device: DEV('qrx') });
ok((await fk0.wait((m) => m.type === 'auth')).qrInvalid === true, "another court's QR is refused");
fk0.ws.close();
await api(`/api/courts/${fc.id}/qr/regenerate`, { method: 'POST' });
const fkR = client(fc.slug, 'score'); await fkR.open;
fkR.send({ type: 'auth', qr: tok1, device: DEV('qrr') });
const rv = await fkR.wait((m) => m.type === 'auth');
ok(rv.ok === false && rv.reason === 'revoked' && /replaced by a newer one/.test(rv.error), `regenerated: old code refused ("${rv.error}")`);
const tok2 = new URL((await api(`/api/courts/${fc.id}/qr`)).body.url).searchParams.get('t');
await api(`/api/courts/${fc.id}/qr/revoke`, { method: 'POST' });
fkR.send({ type: 'auth', qr: tok2, device: DEV('qrr') });
ok((await fkR.wait((m) => m.type === 'auth')).reason === 'revoked', 'revoked: the current code stops working too');
const fkB = client(fc.slug, 'score'); await fkB.open;
const fkBClosed = new Promise((r) => fkB.ws.on('close', (c) => r(c)));
let lastQ; for (let i = 0; i < 5; i++) { fkB.send({ type: 'auth', qr: tok1 + 'x', device: DEV('qrbad') }); lastQ = await fkB.wait((m) => m.type === 'auth'); }
ok(lastQ.locked === true && (await fkBClosed) === 4008, 'invalid QR tokens count toward the per-device lockout (5 -> locked)');
ok(/Too many invalid QR codes/.test(lastQ.error) && lastQ.cause === 'qr' && !/wrong PINs/.test(lastQ.error), `QR lockout wording: "${lastQ.error}"`);
fkR.ws.close();
// r4 #1: Regenerate/Revoke ends sessions created from the older QR version (connected phones are told at once).
const kick = await fk.wait((m) => m.type === 'auth' && m.sessionRevoked);
ok(kick.ok === false && /QR code that has been replaced/.test(kick.error), `signed-in QR phone is signed out on Regenerate ("${kick.error}")`);
const fkS = client(fc.slug, 'score'); await fkS.open;
fkS.send({ type: 'auth', session: qa.session, device: DEV('qr1') });
const sr = await fkS.wait((m) => m.type === 'auth');
ok(sr.ok === false && sr.sessionRevoked === true && sr.needPin, 'reconnecting with an old-QR session is refused with a clear message');
fkS.ws.close();
const tok3 = new URL((await api(`/api/courts/${fc.id}/qr/regenerate`, { method: 'POST' })).body.url).searchParams.get('t');
fk.send({ type: 'auth', qr: tok3, device: DEV('qr1') });
qa = await fk.wait((m) => m.type === 'auth' && m.ok);
ok(qa.how === 'qr' && qa.session, 'the new QR code signs the phone in again');
// PIN sessions survive a QR regenerate
const pw = client('west', 'score'); await pw.open;
pw.send({ type: 'auth', pin: PIN1, device: DEV('pinsess') }); const pws = await pw.wait((m) => m.type === 'auth' && m.ok); pw.ws.close();
const westId = courtsNow.find((c) => c.slug === 'west').id;
const westTok = new URL((await api(`/api/courts/${westId}/qr/regenerate`, { method: 'POST' })).body.url).searchParams.get('t');
const pw2 = client('west', 'score'); await pw2.open;
pw2.send({ type: 'auth', session: pws.session, device: DEV('pinsess') });
ok((await pw2.wait((m) => m.type === 'auth')).ok === true, 'a PIN session stays valid after Regenerate');
// Shared gym IP: a spare phone spamming bad QR codes (105 tries over 21 device ids) locks only itself.
for (let d = 0; d < 21; d++) {
  const sp = client('west', 'score'); await sp.open;
  for (let i = 0; i < 5; i++) { sp.send({ type: 'auth', qr: westTok + 'bad', device: DEV('spare' + d) }); await sp.wait((m) => m.type === 'auth').catch(() => {}); }
  sp.ws.close();
}
const spX = client('west', 'score'); await spX.open;
spX.send({ type: 'auth', qr: westTok + 'bad', device: DEV('spare0') });
const spL = await spX.wait((m) => m.type === 'auth'); spX.ws.close();
const g1c = client('west', 'score'); await g1c.open;
g1c.send({ type: 'auth', qr: westTok, device: DEV('goodqr') }); const g1a = await g1c.wait((m) => m.type === 'auth'); g1c.ws.close();
const g2c = client('west', 'score'); await g2c.open;
g2c.send({ type: 'auth', pin: PIN1, device: DEV('goodpin') }); const g2a = await g2c.wait((m) => m.type === 'auth'); g2c.ws.close();
const g3c = client('west', 'score'); await g3c.open;
g3c.send({ type: 'auth', session: pws.session, device: DEV('pinsess') }); const g3a = await g3c.wait((m) => m.type === 'auth'); g3c.ws.close();
ok(spL.locked === true && g1a.ok && g2a.ok && g3a.ok, `spare phone on the shared IP: itself locked; valid QR, PIN and session on other devices still sign in (${[g1a, g2a, g3a].map((a) => a.ok).join(',')})`);
pw2.ws.close();
// games today on the flow court
const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
const mkToday = async (h, a, plus) => (await api('/api/games', { method: 'POST', body: JSON.stringify({ court_id: fc.id, home_team_id: h, away_team_id: a, scheduled_at: new Date(nowMin + plus * 60_000).toISOString() }) })).body.id;
// an hour apart: same court + same teams can't overlap (create checks, Aaron 2026-10-23)
const GA = await mkToday(G5a, G5b, 0), GB = await mkToday(G5b, G5a, 60);
const tvF = client(fc.slug, 'tv'); await tvF.open;
const st0 = await fk.wait((m) => m.type === 'state' && m.today?.length >= 2);
ok(!st0.game && st0.today.map((t) => t.id).join() === `${GA},${GB}` && st0.today[0].grade === '5th-6th Grade', "picker: today's games on this court that aren't complete");
fk.send({ type: 'load', id: 'L1', gameId: GA });
const l1 = await fk.wait((m) => m.id === 'L1');
const tvA2 = await tvF.wait((m) => m.type === 'state' && m.game?.id === GA);
ok(l1.loaded === GA && tvA2.game.state.status === 'active', 'Load: game A becomes active and the court TV switches to it');
fk.send({ type: 'load', id: 'L2', gameId: GB });
const l2 = await fk.wait((m) => m.id === 'L2');
ok(l2.type === 'error' && /still active on Flow .*Complete it/.test(l2.error), `only one active game per court: "${l2.error}"`);
const adm2 = await api(`/api/games/${GB}/start`, { method: 'POST' });
ok(adm2.status === 409, 'admin "Start on court" is refused too while another game is active');
const sc = await fk.cmd({ type: 'SCORE', team: 'home', pts: 2 });
ok(sc.type === 'ack', 'scoring the active game works');
// resume: another device signs in with the session while A is active
const fk2 = client(fc.slug, 'score'); await fk2.open;
fk2.send({ type: 'auth', session: qa.session, device: DEV('qr2') });
await fk2.wait((m) => m.type === 'auth' && m.ok);
const rs = await fk2.wait((m) => m.type === 'state' && m.game);
ok(rs.game.id === GA && rs.game.state.status === 'active', 'a device that rejoins gets the active game (offered Resume)');
fk2.ws.close();
tvF.msgs = [];
const done = await fk.cmd({ type: 'END_GAME' });
const tvIdle = await tvF.wait((m) => m.type === 'state' && !m.game);
ok(done.type === 'ack' && tvIdle.nextUp?.id === GB && tvIdle.lastFinal?.id === GA && tvIdle.lastFinal.final_home === 2, 'Complete game: TV goes idle with Next up (B) and the last final (A 2-0)');
const lk = await fk.cmd({ type: 'SCORE', team: 'home', pts: 2 });
const lkU = await (async () => { const id = 'u' + RUN; fk.send({ type: 'undo', id }); return fk.wait((m) => m.id === id); })();
ok(lk.type === 'error' && /No game is loaded/.test(lk.error), 'after Complete there is no active game to score');
const gaRow = (await api('/api/games')).body.find((g) => g.id === GA);
ok(gaRow.status === 'complete' && gaRow.home_score === 2 && lkU.type === 'error', 'final score locked (status complete, 2-0; undo refused)');
const reB = await api(`/api/games/${GB}/start`, { method: 'POST' });
const reA = await api(`/api/games/${GA}/reopen`, { method: 'POST' });
ok(reB.status === 200 && reA.status === 409 && /still active/.test(reA.body.error), 'admin reopen is refused while another game is active on the court');
ok((await api(`/api/games/${GB}/complete`, { method: 'POST' })).status === 200, 'admin force-complete');
const reA2 = await api(`/api/games/${GA}/reopen`, { method: 'POST' });
ok(reA2.status === 200 && (await api(`/api/public/court/${fc.slug}`)).body.game?.id === GA, 'admin reopen makes the game active again');
const lockAdmin = await api(`/api/games/${GB}/start`, { method: 'POST' });
ok(lockAdmin.status === 409 && /complete/.test(lockAdmin.body.error), 'a complete game cannot be started again (only reopened)');
await api(`/api/games/${GA}/complete`, { method: 'POST' });
const expF = await fetch(BASE + '/api/export/schedule.csv', { headers: auth }).then((r) => r.text());
const aLine = expF.split(/\r?\n/).find((l) => l.startsWith(GA + ','));
ok(/,2,0,complete,/.test(aLine), `status + final score exported (${aLine})`);
const GC = await mkToday(G5a, G5b, 120);
const cLine = `id,date,time,court,home,away,home_score,away_score,status\n${GC},,,${fc.slug},G5a-${RUN},G5b-${RUN},40,38,complete\n${GA},,,${fc.slug},G5a-${RUN},G5b-${RUN},,,scheduled\n`;
const [dC, tC] = local(nowMin + 2 * 60_000), [dA, tA] = local(nowMin);
const si = await api('/api/import/schedule.csv', { method: 'POST', body: cLine.replace(`${GC},,,`, `${GC},${dC},${tC},`).replace(`${GA},,,`, `${GA},${dA},${tA},`) });
const gcRow = (await api('/api/games')).body.find((g) => g.id === GC);
ok(si.body.updated === 1 && gcRow.status === 'complete' && gcRow.home_score === 40 && /row 3: status complete -> scheduled/.test(si.body.errors[0] || ''), `status import: result recorded for a never-started game; a started game's status is Admin-only (${si.body.errors[0]})`);
const tvHtml = await fetch(BASE + '/upwardbasketballscores/westcourt').then((r) => r.text());
const ovHtml = await fetch(BASE + '/upwardbasketballscores/fullcourt/overlay').then((r) => r.text());
const alias = await fetch(BASE + '/tv/east').then((r) => r.text());
ok(/data-role="tv"/.test(tvHtml) && /data-role="overlay"/.test(ovHtml) && /data-role="tv"/.test(alias), 'TV routes: /upwardbasketballscores/westcourt, …/fullcourt/overlay, and the /tv/east alias');

console.log('17. team names unique per grade; cheer logo export');
const mkT = async (name, grade) => api('/api/teams', { method: 'POST', body: JSON.stringify({ name, grade }) });
const D2 = await mkT(`Dup-${RUN}`, '2nd Grade'), D5 = await mkT(`Dup-${RUN}`, '5th Grade'), D5x = await mkT(`dup-${RUN}`, '5th Grade');
ok(D2.status === 201 && D5.status === 201 && D5x.status === 409 && /already exists in 5th-6th Grade/.test(D5x.body.error), `2nd Grade and 5th Grade "Dup" can both exist; a same-grade twin is refused (${D5x.body.error})`);
const W2 = await mkT(`Twin-${RUN}`, '2nd Grade'), W5 = await mkT(`Twin-${RUN}`, '5th Grade'), M5 = await mkT(`Mate-${RUN}`, '5th Grade');
const ti = await api('/api/import/teams.csv', { method: 'POST', body: `name,short_name,grade\nDup-${RUN},DPX,5th\nDup-${RUN},DUP,2nd Grade\n` });
const tl17 = (await api("/api/teams")).body;
ok(ti.body.updated + ti.body.skipped === 2 && !ti.body.errors.length && tl17.find((t) => t.id === D5.body.id).short_name === 'DPX' && tl17.find((t) => t.id === D2.body.id).short_name !== 'DPX', `teams CSV matches on grade + name (${JSON.stringify(ti.body)})`);
const tiOld = await api('/api/import/teams.csv', { method: 'POST', body: `name,short_name\nDup-${RUN},ZZ\n` });
ok(/add a grade column/.test(tiOld.body.errors[0] || ''), `old teams CSV without grade: ambiguous name is a row error (${tiOld.body.errors[0]})`);
const sch = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,home,away\n,,,Dup-${RUN},Mate-${RUN}\n,,,Dup-${RUN},Twin-${RUN}\n` });
const all17 = () => api('/api/games').then((r) => r.body);
let g17 = (await all17()).filter((g) => [D2, D5, W2, W5, M5].some((t) => t.body.id === g.home_team_id || t.body.id === g.away_team_id));
ok(sch.body.created === 1 && g17[0]?.home_team_id === D5.body.id && /fill the grade \(and gender\) column/.test(sch.body.errors[0] || ''), `schedule CSV infers the grade from the unambiguous team; two ambiguous names are a row error (${sch.body.errors[0]})`);
const sch2 = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,grade,home,away\n,,,2nd Grade,Dup-${RUN},Twin-${RUN}\n,,,3rd Grade,Dup-${RUN},Twin-${RUN}\n` });
g17 = (await all17()).filter((g) => g.home_team_id === D2.body.id);
ok(sch2.body.created === 1 && g17[0]?.away_team_id === W2.body.id && /unknown home team .* in 3rd-4th Grade|within one grade/.test(sch2.body.errors[0] || ''), `schedule CSV grade column picks 2nd Grade Dup vs Twin (${sch2.body.errors[0]})`);
const [dL, tL2] = local(nowMin + 5 * 86400_000);
const cg = await api('/api/games', { method: 'POST', body: JSON.stringify({ court_id: fc.id, home_team_id: D5.body.id, away_team_id: M5.body.id, scheduled_at: iso(D + 3 * 3_600_000), cheer: 'Dup Cheer', cheer_logo_data_url: tiny }) });
const CG = cg.body.id;
const ex17 = await fetch(BASE + '/api/export/cheer_squads.csv', { headers: auth }).then((r) => r.text());
const hdr17 = ex17.split(/\r?\n/)[0], line17 = ex17.split(/\r?\n/).find((l) => l.startsWith('Dup Cheer,'));
const logoUrl = (line17 || '').match(/https?:\/\/[^,]*\/logos\/squad\/\d+/)?.[0];
const lr = logoUrl ? await fetch(logoUrl) : { status: 0 };
ok(cg.status === 201 && logoUrl && lr.status === 200, `uploaded cheer squad logo exported (cheer_squads.csv) as an absolute served URL (${logoUrl})`);
const re17 = await api('/api/import/cheer_squads.csv', { method: 'POST', body: hdr17 + '\n' + line17 + '\n' });
const lr2 = await fetch(logoUrl);
ok(re17.body.skipped === 1 && !re17.body.errors.length && lr2.status === 200, `re-importing the export keeps the uploaded squad logo (${JSON.stringify(re17.body)})`);
console.log('18. Round 4 CSV + ticker fixes');
const [dX, tX] = local(D + 4 * 3_600_000); // a legal Sat evening slot
const copyR4 = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,grade,home,away,cheer,cheer_logo\n${dX},${tX},${fc.slug},5th Grade,Mate-${RUN},Dup-${RUN},Copy Cheer,${logoUrl}\n` });
const copiedR4 = (await all17()).find((g) => g.home_team_id === M5.body.id);
ok(copyR4.body.created === 1 && !copyR4.body.errors.length && copiedR4 && copiedR4.cheer === 'Copy Cheer' && !copiedR4.cheer_logo_url && !copiedR4.cheer_has_logo, `legacy cheer column maps to the time slot; another squad's uploaded logo is not carried over (${JSON.stringify(copyR4.body.warnings)})`);
const blankR4 = line17.split(',');
const hiR4 = hdr17.split(',').indexOf('logo'); blankR4[hiR4] = '';
const clrR4 = await api('/api/import/cheer_squads.csv', { method: 'POST', body: hdr17 + '\n' + blankR4.join(',') + '\n' });
const lr3R4 = await fetch(logoUrl);
ok(clrR4.body.updated === 1 && lr3R4.status === 404, `clearing the squad logo cell removes the uploaded logo (${JSON.stringify(clrR4.body)}, logo ${lr3R4.status})`);
const before18 = (await all17()).find((g) => g.id === CG);
const soR4 = await api('/api/import/schedule.csv', { method: 'POST', body: `id,date,time,court,home,away,home_score,away_score,status\n${CG},,,,,,11,9,complete\n` });
const after18 = (await all17()).find((g) => g.id === CG);
ok(soR4.body.updated === 1 && !soR4.body.errors.length && after18.status === 'complete' && after18.home_score === 11 && after18.scheduled_at === before18.scheduled_at && after18.court_id === before18.court_id && after18.home_team_id === before18.home_team_id, `id + status row updates only the status (${JSON.stringify(soR4.body)})`);
const so2R4 = await api('/api/import/schedule.csv', { method: 'POST', body: `id,status\n${CG},complete\n` });
ok(so2R4.body.skipped === 1 && !so2R4.body.errors.length, 'status-only file without the other columns: unchanged row is skipped');
const tick18 = (await api(`/api/public/court/${fc.slug}`)).body.upNext.find((u) => u.home === `Mate-${RUN}`);
ok(tick18 && tick18.is_today === false && /^\w{3} \w{3} \d+$/.test(tick18.day), `Up next carries the date for a later game (${tick18?.day} ${tick18?.time})`);
for (const g of (await all17()).filter((g) => [D2, D5, W2, W5, M5].some((t) => t.body.id === g.home_team_id))) await api(`/api/games/${g.id}`, { method: 'DELETE' });
for (const t of [D2, D5, W2, W5, M5]) await api(`/api/teams/${t.body.id}`, { method: 'DELETE' });
fk.ws.close(); tvF.ws.close();
for (const id of [GA, GB, GC]) await api(`/api/games/${id}`, { method: 'DELETE' });
await api(`/api/courts/${fc.id}`, { method: 'DELETE' });
// leave the floor free for the next run / the e2e tests
await api(`/api/games/${g1.id}/complete`, { method: 'POST' }); await api(`/api/games/${g2.id}/complete`, { method: 'POST' });

console.log('19. Gender / division, schedule warnings, lobby feed (live) + retired schedule routes 404, home listed first');
{
  const T = (b) => api('/api/teams', { method: 'POST', body: JSON.stringify(b) });
  const gb = await T({ name: `Gx-${RUN}`, grade: '3rd Grade', gender: 'Boys' }), gg = await T({ name: `Gx-${RUN}`, grade: '3rd Grade', gender: 'girls' });
  ok(gb.status === 201 && gg.status === 201, 'same name in one grade is allowed once per gender (Boys + Girls)');
  const gd = await T({ name: `gx-${RUN}`, grade: '3rd Grade', gender: 'Boys' });
  ok(gd.status === 409 && /unique within a grade and gender/.test(gd.body.error), `duplicate grade + gender + name rejected (${gd.body.error})`);
  ok((await T({ name: `Bad-${RUN}`, grade: '3rd Grade', gender: 'coed' })).status === 400, 'gender must be Boys or Girls');
  const b2 = await T({ name: `Hx-${RUN}`, grade: '3rd Grade', gender: 'Boys' });
  const teams19 = (await api('/api/teams')).body;
  ok(teams19.find((t) => t.id === gg.body.id)?.gender === 'Girls', 'teams API returns the gender (normalized)');
  const mix = await api('/api/games', { method: 'POST', body: JSON.stringify({ court_id: (await api('/api/courts')).body.find((c) => c.slug === 'west').id, home_team_id: gb.body.id, away_team_id: gg.body.id }) });
  ok(mix.status === 400 && /one gender/.test(mix.body.error), `a game must be within one gender (${mix.body.error})`);
  const ti = await api('/api/import/teams.csv', { method: 'POST', body: `name,short_name,grade,gender\nIx-${RUN},IX,3rd Grade,Girls\nGx-${RUN},GXG,3rd Grade,Girls\n` });
  ok(ti.body.created === 1 && ti.body.updated === 1 && !ti.body.errors.length, `teams CSV gender column: creates + matches by grade + gender + name (${JSON.stringify(ti.body)})`);
  const exT = await fetch(BASE + '/api/export/teams.csv', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
  ok(/^name,short_name,grade,gender,coach,logo_url/.test(exT) && exT.includes(`Lady Gx-${RUN},GXG,3rd-4th Grade,Girls`), 'teams export has the gender column');
  // Schedule CSV: gender column picks the right Gx team; warnings for team twice in a weekend, split hours, cheer rules.
  const FRI = '2031-01-03', SAT = '2031-01-04';
  const si = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,grade,gender,home,away,home_cheer\n${SAT},09:00,west,3rd Grade,Boys,Gx-${RUN},Hx-${RUN},Sx Cheer\n${SAT},09:00,east,3rd Grade,Girls,Gx-${RUN},Ix-${RUN},\n${FRI},18:00,east,3rd Grade,Boys,Hx-${RUN},Gx-${RUN},Fri Cheer\n${SAT},10:00,west,3rd Grade,Girls,Gx-${RUN},Hx-${RUN},\n` });
  const w19 = si.body.warnings || [];
  const leg = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,grade,gender,home,away,home_cheer,away_cheer\n${SAT},09:00,west,3rd Grade,Boys,Gx-${RUN},Hx-${RUN},Sx Cheer,Other Cheer\n` });
  ok(leg.body.skipped === 1 && (leg.body.warnings || []).some((w) => /two cheer squads .* kept "Sx Cheer"/.test(w)), `legacy home_cheer + away_cheer: one squad kept (home) with a warning (${(leg.body.warnings || [])[0]})`);
  ok(si.body.created === 3 && w19.some((w) => /Gx-\w+ plays 2 times this weekend/.test(w)) && w19.some((w) => /outside the split-court hours/.test(w)) && w19.some((w) => /only on Saturday split-court/.test(w)),
    `schedule import: 3 games + warnings (twice in a weekend, split hours, cheer) (${w19.length} warnings)`);
  ok(si.body.errors.some((e) => /row 5: .*(one gender|doesn't match|unknown away)/.test(e)), `schedule CSV gender column rejects a mixed / wrong-gender row (${si.body.errors[0]})`);
  const games19 = (await api('/api/games')).body.filter((g) => [gb.body.id, gg.body.id, b2.body.id].includes(g.home_team_id));
  const satW = games19.find((g) => g.court === 'West');
  ok(satW && satW.label === '3rd-4th Grade Boys' && satW.gender === 'Boys' && satW.warnings.some((w) => /plays 2 times/.test(w)), `games API: label "${satW?.label}" + per-game warnings`);
  ok((await api('/api/warnings')).body.some((w) => w.gameId === satW.id), '/api/warnings lists them');
  const exS = await fetch(BASE + '/api/export/schedule.csv', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
  const hS = exS.split(/\r?\n/)[0].split(',');
  ok(hS.indexOf('home') < hS.indexOf('away') && hS.indexOf('home_score') < hS.indexOf('away_score') && hS.includes('gender'), 'schedule export: home before away (names + scores), gender column');
  // Retired full-day schedule screen: the routes 404 like any unknown path; the lobby TV feed (role=schedule) stays.
  for (const u of ['/schedule', '/upwardbasketballscores/schedule', '/schedule?day=sat', '/upwardbasketballscores/schedule/?date=2031-01-04', '/schedule.html', '/schedule.js', '/schedule-view.js', '/schedule.css'])
    ok((await fetch(BASE + u, { redirect: 'manual' })).status === 404, `GET ${u} -> 404 (old schedule screen retired)`);
  for (const u of ['/lobby', '/upwardbasketballscores/lobby', '/upwardbasketballscores/lobby?date=2031-01-04']) ok((await fetch(BASE + u)).status === 200, `GET ${u} serves the lobby TV`);
  const gdays = (await api('/api/public/game-days')).body;
  ok(/^\d{4}-\d{2}-\d{2}$/.test(gdays.today) && Array.isArray(gdays.days) && gdays.days.every((d, i, a) => d.date >= gdays.today && /^\d{2}:\d{2}$/.test(d.first) && (!i || a[i - 1].date < d.date)), `lobby idle/demo: /api/public/game-days lists ${gdays.days.length} game days from today on, with first tip-off`);
  const lcss = await fetch(BASE + '/lobby.css').then((r) => r.text()), lhtml = await fetch(BASE + '/upwardbasketballscores/lobby').then((r) => r.text());
  ok(lcss.includes('--lobby-scale') && lcss.includes('@media print') && /width=device-width/.test(lhtml), 'lobby: fit-to-viewport scale + print block, device-width viewport');
  const snap19 = (await api(`/api/public/schedule?date=${SAT}`)).body;
  const sg = snap19.games.find((g) => g.id === satW.id);
  ok(snap19.date === SAT && Array.isArray(snap19.cheerSlots) && sg && sg.time === '09:00' && sg.court === 'west' && sg.home.name === `Gx-${RUN}` && 'locker' in sg.home && !('label' in sg) && !('dayLabel' in snap19),
    'lobby feed: date, time, court, home first with locker; old-screen-only fields (label, dayLabel) gone');
  ok((await api('/api/public/schedule?day=fri')).body.date && new Date((await api('/api/public/schedule?day=fri')).body.date + 'T12:00:00Z').getUTCDay() === 5, '?day=fri resolves to a Friday');
  const sc = client('*', `schedule&date=${SAT}`); await sc.open;
  const first = await sc.wait((m) => m.type === 'state' && m.kind === 'schedule');
  ok(first.date === SAT && first.games.some((g) => g.id === satW.id), 'lobby WebSocket sends the day snapshot on connect');
  for (const g of (await api('/api/games')).body.filter((g) => g.status === 'active' && ['West', 'East', 'Full'].includes(g.court))) await api(`/api/games/${g.id}/complete`, { method: 'POST' });
  await api(`/api/games/${satW.id}/start`, { method: 'POST' });
  ok(!!(await sc.wait((m) => m.kind === 'schedule' && m.games.find((g) => g.id === satW.id)?.status === 'active').catch(() => null)), 'lobby feed updates live when a game becomes active');
  const sk19 = client('west', 'score'); await sk19.open;
  sk19.send({ type: 'auth', pin: PIN1, device: DEV('sk19') }); await sk19.wait((m) => m.type === 'auth' && m.ok);
  await sk19.cmd({ type: 'SCORE', team: 'home', pts: 2 });
  const sl = await sc.wait((m) => m.kind === 'schedule' && m.games.find((g) => g.id === satW.id)?.home.score === 2).catch(() => null);
  ok(sl && sl.games.find((g) => g.id === satW.id).clock && sl.games.find((g) => g.id === satW.id).period === 1, 'live score + clock + period reach the lobby feed');
  const ag = (await api('/api/games')).body.find((g) => g.id === satW.id);
  ok(ag.status === 'active' && ag.home_score === 2 && ag.away_score === 0 && ag.on_court === true, 'A1: Admin games payload has the active game with its live score (2–0)');
  await api(`/api/games/${satW.id}/complete`, { method: 'POST' });
  const fin = await sc.wait((m) => m.kind === 'schedule' && m.games.find((g) => g.id === satW.id)?.status === 'complete').catch(() => null);
  ok(fin && fin.games.find((g) => g.id === satW.id).home.score === 2, 'complete reaches the lobby feed with the final score');
  const cg = (await api('/api/games')).body.find((g) => g.id === satW.id);
  ok(cg.status === 'complete' && cg.home_score === 2 && cg.away_score === 0 && cg.court === 'West' && cg.scheduled_at, 'A1: Admin games payload keeps the completed game with its final score (2–0), court and time');
  const sc2 = client('*', 'schedule&date=2031-01-05'); await sc2.open;
  const other = await sc2.wait((m) => m.kind === 'schedule');
  ok(other.games.every((g) => g.id !== satW.id) && other.date === '2031-01-05', 'a lobby screen only gets its own day');
  sc2.send({ type: 'cmd', id: 'x', cmd: { type: 'SCORE', team: 'home', pts: 2 } });
  ok(/read-only/.test((await sc2.wait((m) => m.type === 'error')).error), 'lobby feed is read-only');
  const tieG = games19.find((g) => g.court === 'East' && g.cheer === 'Fri Cheer'); // the Friday 18:00 game (not live yet)
  await api(`/api/games/${tieG.id}/start`, { method: 'POST', body: JSON.stringify({ force: true }) });
  await api(`/api/games/${tieG.id}/complete`, { method: 'POST' }); // 0–0 final = tie
  const tieRow = (await api('/api/games')).body.find((g) => g.id === tieG.id);
  ok(tieRow.status === 'complete' && tieRow.home_score === tieRow.away_score, `A1: Admin games payload: tied final ${tieRow.home_score}–${tieRow.away_score} (Today shows FINAL + TIE)`);
  const emp = (await api('/api/public/schedule?date=2031-01-06')).body;
  ok(emp.games.length === 0 && emp.cheerSlots.length === 0, 'empty day: no games, no cheer slots');
  // A3: a game completed by CSV import (never ran here) reopens with its stored final, not 0–0.
  for (const g of (await api('/api/games')).body.filter((g) => g.status === 'active' && ['West', 'East', 'Full'].includes(g.court))) await api(`/api/games/${g.id}/complete`, { method: 'POST' });
  const a3 = await api('/api/import/schedule.csv', { method: 'POST', body: `date,time,court,grade,gender,home,away\n2031-01-10,09:00,west,3rd Grade,Boys,Gx-${RUN},Hx-${RUN}\n` });
  const a3g = (await api('/api/games')).body.find((g) => g.home_team_id === gb.body.id && g.away_team_id === b2.body.id && g.court === 'West' && g.status === 'scheduled');
  await api('/api/import/schedule.csv', { method: 'POST', body: `id,status,home_score,away_score\n${a3g.id},complete,10,16\n` });
  const ro = await api(`/api/games/${a3g.id}/reopen`, { method: 'POST', body: JSON.stringify({ force: true }) });
  const a3r = (await api('/api/games')).body.find((g) => g.id === a3g.id);
  ok(a3.body.created === 1 && ro.status === 200 && a3r.status === 'active' && a3r.home_score === 10 && a3r.away_score === 16, `A3: CSV final 10–16 -> Reopen -> active ${a3r.home_score}–${a3r.away_score}`);
  const a3pub = (await api('/api/public/court/west')).body.game;
  ok(a3pub?.state?.home.score === 10 && a3pub.state.away.score === 16 && a3pub.state.status === 'active', 'A3: the West TV shows 10–16 live after the reopen');
  await api(`/api/games/${a3g.id}/complete`, { method: 'POST' });
  ok((await api('/api/games')).body.find((g) => g.id === a3g.id).home_score === 10, 'A3: completing again keeps 10–16');
  sc.ws.close(); sc2.ws.close(); sk19.ws.close();
  for (const g of (await api('/api/games')).body.filter((g) => [gb.body.id, gg.body.id, b2.body.id].includes(g.home_team_id))) await api(`/api/games/${g.id}`, { method: 'DELETE' });
  for (const t of (await api('/api/teams')).body.filter((t) => t.name.endsWith(`x-${RUN}`))) await api(`/api/teams/${t.id}`, { method: 'DELETE' });
}

for (const c of [tv1b, tv2, sk1b, sk1c, sk2]) c.ws.close();
console.log(`\nSmoke result: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
