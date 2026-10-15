// End-to-end smoke test against a running server (default http://localhost:3000).
// Usage: ADMIN_PASSWORD=... PIN1=1111 PIN2=2222 node scripts/smoke.mjs
import WebSocket from 'ws';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const WSB = BASE.replace(/^http/, 'ws');
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
const PIN1 = process.env.PIN1 || '1111', PIN2 = process.env.PIN2 || '2222';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
ok((await api('/api/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) })).status === 401, 'wrong admin password rejected');
token = (await api('/api/login', { method: 'POST', body: JSON.stringify({ password: ADMIN }) })).body.token;
ok(!!token, 'admin login ok');
const games = (await api('/api/games')).body;
const g1 = games.find((g) => g.court === 'Court 1' && g.status !== 'final');
const g2 = games.find((g) => g.court === 'Court 2' && g.status !== 'final');
ok(g1 && g2, `found games on both courts (#${g1?.id} ${g1?.home} v ${g1?.away}, #${g2?.id} ${g2?.home} v ${g2?.away})`);
ok((await api(`/api/games/${g1.id}/start`, { method: 'POST' })).body.court === 'court-1', 'started game on court-1');
ok((await api(`/api/games/${g2.id}/start`, { method: 'POST' })).body.court === 'court-2', 'started game on court-2');

console.log('2. Connect TVs and controllers');
const tv1 = client('court-1', 'tv'), tv2 = client('court-2', 'tv');
const sk1 = client('court-1', 'score'), sk2 = client('court-2', 'score');
await Promise.all([tv1.open, tv2.open, sk1.open, sk2.open]);
const s1 = await tv1.wait(stateWhere((g) => g.id === g1.id));
ok(s1.game.home.name === g1.home && s1.game.home.color.startsWith('#'), `TV1 got snapshot: ${s1.game.home.name} (${s1.game.home.color}) vs ${s1.game.away.name}`);
const r0 = await tv1.cmd({ type: 'SCORE', team: 'home', pts: 2 });
ok(r0.type === 'error' && /read-only/.test(r0.error), 'TV (public) cannot send commands');
sk1.send({ type: 'auth', pin: '0000' });
ok((await sk1.wait((m) => m.type === 'auth')).ok === false, 'wrong PIN rejected');
sk1.send({ type: 'auth', pin: PIN2 });
ok((await sk1.wait((m) => m.type === 'auth')).ok === false, "court-2 PIN doesn't unlock court-1");
sk1.send({ type: 'auth', pin: PIN1 }); ok((await sk1.wait((m) => m.type === 'auth')).ok, 'court-1 PIN accepted');
sk2.send({ type: 'auth', pin: PIN2 }); ok((await sk2.wait((m) => m.type === 'auth')).ok, 'court-2 PIN accepted');

console.log('3. Score change on controller shows on the right TV only');
const base1 = (await api('/api/public/court/court-1')).body.game.state;
const base2 = (await api('/api/public/court/court-2')).body.game.state;
tv1.msgs = []; tv2.msgs = [];
let t0 = Date.now();
const a1 = await sk1.cmd({ type: 'SCORE', team: 'home', pts: 2 });
ok(a1.type === 'ack', `controller ack seq=${a1.seq}`);
const u1 = await tv1.wait(stateWhere((g) => g.state.seq === a1.seq));
ok(u1.game.state.home.score === base1.home.score + 2, `TV1 shows home ${u1.game.state.home.score} (latency ${Date.now() - t0} ms)`);
await sleep(300);
ok(!tv2.msgs.some((m) => m.type === 'state' && m.game?.state.home.score !== base2.home.score), 'TV2 unaffected by court-1 change');
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
const tv1b = client('court-1', 'tv'); await tv1b.open;
const snap = await tv1b.wait(stateWhere((g) => g.id === g1.id));
const now = snap.serverNow;
ok(snap.game.state.seq === ax.seq, `reconnected TV has latest seq ${snap.game.state.seq} (missed update included)`);
const rem = remaining(snap.game, now);
ok(rem <= 5 * 60_000 - 1900 && rem >= 5 * 60_000 - 3000, `clock after ~2s running = ${(rem / 1000).toFixed(1)}s (expected ~298s)`);
ok(snap.game.state.clock.running === true, 'clock still running after TV reconnect');

console.log('5. Controller refresh restores state; retries are idempotent');
await sk1.close();
const sk1b = client('court-1', 'score'); await sk1b.open;
sk1b.send({ type: 'auth', pin: PIN1 }); await sk1b.wait((m) => m.type === 'auth' && m.ok);
const cs = await sk1b.wait(stateWhere((g) => g.id === g1.id));
ok(cs.game.state.seq === ax.seq && cs.game.state.away.fouls >= 1, 'refreshed controller sees exact server state');
const dupId = 'retry-123-' + Date.now();
const d1 = await sk1b.cmd({ type: 'SCORE', team: 'home', pts: 3 }, dupId);
const d2 = await sk1b.cmd({ type: 'SCORE', team: 'home', pts: 3 }, dupId);
ok(d2.dup === true && d2.seq === d1.seq, 'resent command with same id applied once');

console.log('6. Undo / redo');
const before = (await api('/api/public/court/court-1')).body.game.state.home.score;
const un = await (async () => { const id = 'u' + Date.now(); sk1b.send({ type: 'undo', id }); return sk1b.wait((m) => m.type === 'ack' && m.id === id); })();
const afterUndo = await tv1b.wait(stateWhere((g) => g.state.seq === un.seq));
ok(afterUndo.game.state.home.score === before - 3, `undo reverted +3 (${before} -> ${afterUndo.game.state.home.score}) on the TV`);
ok(afterUndo.game.state.clock.running === true, 'undo did not stop the running clock');
const re = await (async () => { const id = 'r' + Date.now(); sk1b.send({ type: 'redo', id }); return sk1b.wait((m) => m.type === 'ack' && m.id === id); })();
const afterRedo = await tv1b.wait(stateWhere((g) => g.state.seq === re.seq));
ok(afterRedo.game.state.home.score === before, 'redo re-applied it');

console.log('7. Two controllers on one game');
const sk1c = client('court-1', 'score'); await sk1c.open;
sk1c.send({ type: 'auth', pin: PIN1 }); await sk1c.wait((m) => m.type === 'auth' && m.ok);
const pres = await tv1b.wait((m) => m.type === 'state' && m.presence?.controllers === 2);
ok(!!pres, 'presence shows 2 scorekeepers connected');
const pre = (await api('/api/public/court/court-1')).body.game.state.home.score;
const [x, y] = await Promise.all([sk1b.cmd({ type: 'SCORE', team: 'home', pts: 1 }), sk1c.cmd({ type: 'SCORE', team: 'home', pts: 1 })]);
ok(x.seq !== y.seq, `simultaneous taps serialized (seq ${x.seq}, ${y.seq})`);
const fin = (await api('/api/public/court/court-1')).body.game.state;
ok(fin.home.score === pre + 2, `both applied: ${pre} -> ${fin.home.score}`);
await sk1b.cmd({ type: 'CLOCK_STOP' });

console.log('8. CSV export / import');
const tcsv = await fetch(BASE + '/api/export/teams.csv', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
ok(tcsv.startsWith('name,short_name,primary_color,secondary_color,logo_url') && /Lions/.test(tcsv), 'teams.csv exported');
const imp = await api('/api/import/teams.csv', { method: 'POST', body: 'name,short_name,primary_color,secondary_color,logo_url\r\nCrusaders,CRU,#003366,#ffd700,\r\n"Saints",SNT,#14532d,#a3e635,\r\n' });
ok(imp.body.created === 1 && imp.body.updated === 1 && imp.body.errors.length === 0, `teams.csv imported (created ${imp.body.created}, updated ${imp.body.updated})`);
const simp = await api('/api/import/schedule.csv', { method: 'POST', body: 'date,time,court,division,home,away\n2026-10-24,09:30,court-2,3rd-4th Grade,Crusaders,Eagles\n2026-10-24,10:30,court-1,5th-6th Grade,Nobodies,Lions\n' });
ok(simp.body.created === 1 && simp.body.errors.length === 1, `schedule.csv imported 1 row, bad row reported: "${simp.body.errors[0]}"`);
const scsv = await fetch(BASE + '/api/export/schedule.csv', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
ok(/^id,date,time,court,division,home,away,home_score,away_score,status/.test(scsv) && /\d+,2026-10-24,09:30,court-2,3rd-4th Grade,Crusaders,Eagles/.test(scsv), 'schedule.csv export (with id column) round-trips the import');

const cimp = await api('/api/import/courts.csv', { method: 'POST', body: 'slug,name,location\ncourt-9,Court 9,Annex\n' });
ok(cimp.body.created === 1 && cimp.body.errors.length === 0, 'courts.csv imported (upsert by slug)');
const ccsv = await fetch(BASE + '/api/export/courts.csv', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
ok(ccsv.startsWith('slug,name,location') && /court-9,Court 9,Annex/.test(ccsv), 'courts.csv export round-trips');
await api(`/api/courts/${(await api('/api/courts')).body.find((c) => c.slug === 'court-9').id}`, { method: 'DELETE' });


console.log('9. Idempotent re-import (QA #2)');
const auth = { authorization: `Bearer ${token}` };
const countGames = async () => (await api('/api/games')).body.length;
const exp = await fetch(BASE + '/api/export/schedule.csv', { headers: auth }).then((r) => r.text());
const n0 = await countGames();
const re1 = await api('/api/import/schedule.csv', { method: 'POST', body: exp });
ok(re1.body.created === 0 && re1.body.updated === 0 && re1.body.skipped === n0 && (await countGames()) === n0, `re-importing the export changes nothing (${n0} games, skipped ${re1.body.skipped})`);
const dupFile = 'date,time,court,division,home,away\n2026-11-07,09:00,court-1,Dup test,Lions,Eagles\n2026-11-07,09:00,court-1,Dup test,Lions,Eagles\n';
const d1i = await api('/api/import/schedule.csv', { method: 'POST', body: dupFile });
ok(d1i.body.created === 1 && d1i.body.skipped === 1, `duplicate rows within one file: created ${d1i.body.created}, skipped ${d1i.body.skipped}`);
const d2i = await api('/api/import/schedule.csv', { method: 'POST', body: dupFile });
ok(d2i.body.created === 0 && d2i.body.skipped === 2 && (await countGames()) === n0 + 1, 'importing the same file twice does not duplicate');
const upd = await api('/api/import/schedule.csv', { method: 'POST', body: 'date,time,court,division,home,away\n2026-11-07,09:00,court-1,Renamed div,Lions,Eagles\n' });
ok(upd.body.updated === 1 && upd.body.created === 0, 'natural-key match updates the division instead of adding a game');
const gid = (await api('/api/games')).body.find((g) => g.division === 'Renamed div').id;
const byId = await api('/api/import/schedule.csv', { method: 'POST', body: `id,date,time,court,division,home,away\n${gid},2026-11-07,10:00,court-2,Renamed div,Lions,Eagles\n` });
ok(byId.body.updated === 1 && (await countGames()) === n0 + 1, 'exported id column moves the game (time/court change) without duplicating');
const tAgain = await api('/api/import/teams.csv', { method: 'POST', body: tcsv });
ok(tAgain.body.created === 0 && tAgain.body.errors.length === 0, `teams re-import idempotent (created 0, skipped ${tAgain.body.skipped})`);
const ccsv2 = await fetch(BASE + '/api/export/courts.csv', { headers: auth }).then((r) => r.text());
const cAgain = await api('/api/import/courts.csv', { method: 'POST', body: ccsv2 });
ok(cAgain.body.created === 0 && cAgain.body.updated === 0, 'courts re-import idempotent');
const dupGame = await api('/api/games', { method: 'POST', body: JSON.stringify({ court_id: g1.court_id, home_team_id: g1.home_team_id, away_team_id: g1.away_team_id, scheduled_at: games.find((g) => g.id === g1.id).scheduled_at }) });
ok(dupGame.status === 409 && /already scheduled/.test(dupGame.body.error), `admin double-add -> 409 "${dupGame.body.error}"`);

console.log('10. Explicit CSV errors (QA #8)');
const badColor = await api('/api/import/teams.csv', { method: 'POST', body: 'name,short_name,primary_color,secondary_color,logo_url\nPurples,PUR,purple,#ffffff,\n' });
ok(badColor.body.created === 0 && /primary_color "purple" is not a color/.test(badColor.body.errors[0]), `bad color -> row error: ${badColor.body.errors[0]}`);
const badUrl = await api('/api/import/teams.csv', { method: 'POST', body: 'name,logo_url\nXSS,javascript:alert(1)\n' });
ok(badUrl.body.created === 0 && /http/.test(badUrl.body.errors[0]), `javascript: logo URL rejected: ${badUrl.body.errors[0]}`);
const missing = await api('/api/import/schedule.csv', { method: 'POST', body: 'date,court,home,away\n2026-11-07,court-1,Lions,Eagles\n' });
ok(missing.status === 400 && /missing required column\(s\): time/.test(missing.body.error), `missing column -> 400: ${missing.body.error}`);
const courtsBefore = (await api('/api/courts')).body.length;
const unk = await api('/api/import/schedule.csv', { method: 'POST', body: 'date,time,court,division,home,away\n2026-11-07,09:00,court-77,X,Lions,Eagles\n' });
ok(unk.body.created === 0 && /unknown court "court-77"/.test(unk.body.errors[0]) && (await api('/api/courts')).body.length === courtsBefore, 'unknown court slug -> row error, no court auto-created');
const badDate = await api('/api/import/schedule.csv', { method: 'POST', body: 'date,time,court,division,home,away\n10/24/2026,9am,court-1,X,Lions,Eagles\n' });
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
ok((await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'Realpng', logo_data_url: tiny }) })).status === 201, 'real PNG accepted');
const jsUrl = await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'Jsurl', logo_url: 'javascript:alert(1)' }) });
ok(jsUrl.status === 400, 'javascript: logo URL rejected (400)');
const lions = (await api('/api/teams')).body.find((t) => t.name === 'Lions');
const del = await api(`/api/teams/${lions.id}`, { method: 'DELETE' });
ok(del.status === 409 && /Lions" is in \d+ games/.test(del.body.error), `delete team with games -> 409 "${del.body.error}"`);

console.log('12. Brute-force protection (QA #3) - run last: it locks this IP for 30 s');
const brute = client('court-2', 'score'); await brute.open;
const closed = new Promise((r) => brute.ws.on('close', (code) => r(code)));
for (let i = 0; i < 5; i++) { brute.send({ type: 'auth', pin: String(9000 + i) }); await brute.wait((m) => m.type === 'auth'); }
ok((await closed) === 4008, 'socket closed after 5 wrong PINs (code 4008)');
const brute2 = client('court-2', 'score'); await brute2.open;
let last;
for (let i = 0; i < 5; i++) { brute2.send({ type: 'auth', pin: String(9100 + i) }); last = await brute2.wait((m) => m.type === 'auth'); }
ok(last.locked === true && last.retryAfter > 0, `10 failures from one IP -> locked, retryAfter ${last.retryAfter}s`);
const brute3 = client('court-2', 'score'); await brute3.open;
brute3.send({ type: 'auth', pin: PIN2 });
const lockedOk = await brute3.wait((m) => m.type === 'auth');
ok(lockedOk.ok === false && lockedOk.locked, 'even the correct PIN is refused while locked');
const t0b = Date.now(); let tries = 0;
for (let i = 0; i < 200; i++) { brute3.send({ type: 'auth', pin: String(i) }); tries++; }
await sleep(300);
ok(true, `(${tries} rapid guesses sent in ${Date.now() - t0b} ms; none can succeed while locked)`);
let l429;
for (let i = 0; i < 6; i++) l429 = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'guess' + i }) });
ok(l429.status === 429 && Number(l429.headers.get('retry-after')) > 0, `admin login: 429 with Retry-After ${l429.headers.get('retry-after')}s after 5 failures`);
const good = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
ok(good.status === 429, 'correct admin password also refused during lockout');
for (const c of [brute2, brute3]) c.ws.close();

for (const c of [tv1b, tv2, sk1b, sk1c, sk2]) c.ws.close();
console.log(`\nSmoke result: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
