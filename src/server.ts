// UpwardScoreboard: one Node process serves the web UI, REST API and
// WebSocket realtime channel. Postgres is the only other moving part.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { pool, migrate, seedIfEmpty } from './db.js';
import { parseCsv, toCsv } from './csv.js';
import {
  History, Command, newHistory, initialState, dispatch, undo, redo, parseCommand, remainingMs, isBonus,
} from './game.js';

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const LEAGUE_NAME = process.env.LEAGUE_NAME || 'UpwardScoreboard';
const COURT_PINS = new Map(
  (process.env.COURT_PINS || '').split(',').map((p) => p.trim().split(':')).filter((p) => p.length === 2) as [string, string][],
);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set; admin login is disabled.');

// ---------------------------------------------------------------- auth (POC)
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const sign = (v: string) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
function makeToken(): string { const exp = String(Date.now() + 12 * 3600_000); return `${exp}.${sign(exp)}`; }
function validToken(t: string | undefined): boolean {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  return !!exp && !!sig && safeEq(sig, sign(exp)) && Number(exp) > Date.now();
}
function tokenFrom(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  const m = /(?:^|;\s*)sb_admin=([^;]+)/.exec(req.headers.cookie || '');
  return m?.[1];
}
const pinOk = (court: string, pin: unknown) => typeof pin === 'string' && COURT_PINS.has(court) && safeEq(pin, COURT_PINS.get(court)!);

// ------------------------------------------------------------- game runtime
interface Runtime { history: History; queue: Promise<unknown>; timer?: NodeJS.Timeout; seen: string[]; }
const runtimes = new Map<number, Runtime>();

async function getRuntime(gameId: number): Promise<Runtime> {
  let rt = runtimes.get(gameId);
  if (rt) return rt;
  const { rows } = await pool.query('SELECT history, rules FROM games WHERE id=$1', [gameId]);
  if (!rows.length) throw new Error('game not found');
  rt = runtimes.get(gameId); // another caller may have loaded it meanwhile
  if (rt) return rt;
  rt = { history: rows[0].history ?? newHistory(initialState(rows[0].rules || {})), queue: Promise.resolve(), seen: [] };
  runtimes.set(gameId, rt);
  armClock(gameId, rt);
  return rt;
}

function armClock(gameId: number, rt: Runtime) {
  clearTimeout(rt.timer);
  const c = rt.history.present.clock;
  if (!c.running) return;
  const ms = remainingMs(c, Date.now());
  rt.timer = setTimeout(() => { void mutate(gameId, 'system', null, (h) => dispatch(h, { type: 'CLOCK_EXPIRE' }, Date.now()), { type: 'CLOCK_EXPIRE' }); }, ms + 5);
}

type Op = (h: History) => History;
/** Serialize every change to a game through one queue: the server is the single source of truth. */
async function mutate(gameId: number, actor: string, cmdId: string | null, op: Op, logged: unknown): Promise<{ seq: number; dup?: boolean }> {
  const rt = await getRuntime(gameId);
  const run = rt.queue.then(async () => {
    if (cmdId && rt.seen.includes(cmdId)) return { seq: rt.history.present.seq, dup: true }; // retry-safe
    const before = rt.history;
    const after = op(before);
    if (cmdId) { rt.seen.push(cmdId); if (rt.seen.length > 500) rt.seen.shift(); }
    if (after === before) return { seq: before.present.seq };
    const p = after.present;
    await pool.query(
      `UPDATE games SET history=$2, status=$3, final_home=$4, final_away=$5, updated_at=now() WHERE id=$1`,
      [gameId, after, p.status, p.status === 'final' ? p.home.score : null, p.status === 'final' ? p.away.score : null]);
    await pool.query('INSERT INTO game_events(game_id, seq, client_cmd_id, actor, command) VALUES ($1,$2,$3,$4,$5)',
      [gameId, p.seq, cmdId, actor, JSON.stringify(logged)]);
    rt.history = after;
    armClock(gameId, rt);
    await broadcastGame(gameId);
    return { seq: p.seq };
  });
  rt.queue = run.catch(() => undefined);
  return run;
}

// ------------------------------------------------------------ view models
function teamView(r: any, prefix: string, theme: any, side: 'home' | 'away') {
  const id = r[`${prefix}_id`];
  return {
    id,
    name: theme[`${side}Name`] || r[`${prefix}_name`],
    short: r[`${prefix}_short`] || r[`${prefix}_name`]?.slice(0, 3).toUpperCase(),
    color: theme[`${side}Color`] || r[`${prefix}_primary`],
    accent: theme[`${side}Accent`] || r[`${prefix}_secondary`],
    logo: theme[`${side}Logo`] || (r[`${prefix}_has_logo`] ? `/logos/${id}` : r[`${prefix}_logo_url`] || null),
  };
}

const GAME_SELECT = `
  SELECT g.*, c.slug AS court_slug, c.name AS court_name,
    h.name AS home_name, h.short_name AS home_short, h.primary_color AS home_primary, h.secondary_color AS home_secondary,
    h.logo_url AS home_logo_url, (h.logo_data IS NOT NULL) AS home_has_logo,
    a.name AS away_name, a.short_name AS away_short, a.primary_color AS away_primary, a.secondary_color AS away_secondary,
    a.logo_url AS away_logo_url, (a.logo_data IS NOT NULL) AS away_has_logo
  FROM games g JOIN teams h ON h.id=g.home_team_id JOIN teams a ON a.id=g.away_team_id
  LEFT JOIN courts c ON c.id=g.court_id`;

// teamView reads columns like home_team_name; alias the joined names onto that shape.
function normalizeRow(r: any) {
  for (const side of ['home', 'away']) {
    r[`${side}_team_name`] = r[`${side}_name`]; r[`${side}_team_short`] = r[`${side}_short`];
    r[`${side}_team_primary`] = r[`${side}_primary`]; r[`${side}_team_secondary`] = r[`${side}_secondary`];
    r[`${side}_team_logo_url`] = r[`${side}_logo_url`]; r[`${side}_team_has_logo`] = r[`${side}_has_logo`];
  }
  return r;
}

async function courtSnapshot(slug: string) {
  const c = (await pool.query('SELECT * FROM courts WHERE slug=$1', [slug])).rows[0];
  if (!c) return null;
  const game = c.current_game_id ? await gameViewNorm(c.current_game_id) : null;
  const upNext = (await pool.query(
    `SELECT g.id, to_char(g.scheduled_at AT TIME ZONE current_setting('TimeZone'), 'HH24:MI') AS time, h.name AS home, a.name AS away
     FROM games g JOIN teams h ON h.id=g.home_team_id JOIN teams a ON a.id=g.away_team_id
     WHERE g.court_id=$1 AND g.status='scheduled' AND g.id IS DISTINCT FROM $2
     ORDER BY g.scheduled_at NULLS LAST, g.id LIMIT 3`, [c.id, c.current_game_id])).rows;
  return { type: 'state', serverNow: Date.now(), league: LEAGUE_NAME, court: { slug: c.slug, name: c.name }, game, upNext };
}

async function gameViewNorm(gameId: number) {
  const { rows } = await pool.query(`${GAME_SELECT} WHERE g.id=$1`, [gameId]);
  if (!rows.length) return null;
  const r = normalizeRow(rows[0]);
  const rt = await getRuntime(gameId);
  const theme = r.theme || {};
  const s = rt.history.present;
  return {
    id: r.id, division: r.division, scheduledAt: r.scheduled_at,
    court: r.court_slug ? { slug: r.court_slug, name: r.court_name } : null,
    home: { ...teamView(r, 'home_team', theme, 'home'), bonus: isBonus(s, 'home') },
    away: { ...teamView(r, 'away_team', theme, 'away'), bonus: isBonus(s, 'away') },
    state: s, canUndo: rt.history.past.length > 0, canRedo: rt.history.future.length > 0,
  };
}

// -------------------------------------------------------------- websockets
interface Client { ws: WebSocket; court: string; role: 'tv' | 'overlay' | 'score' | 'viewer'; authed: boolean; }
const clients = new Set<Client>();

function send(c: Client, msg: unknown) { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg)); }

async function broadcastCourt(slug: string) {
  const targets = [...clients].filter((c) => c.court === slug);
  if (!targets.length) return;
  const snap = await courtSnapshot(slug);
  if (!snap) return;
  const controllers = targets.filter((c) => c.role === 'score' && c.authed).length;
  const tvs = targets.filter((c) => c.role === 'tv' || c.role === 'overlay').length;
  for (const c of targets) send(c, { ...snap, presence: { controllers, displays: tvs } });
}
async function broadcastGame(gameId: number) {
  const { rows } = await pool.query('SELECT slug FROM courts WHERE current_game_id=$1', [gameId]);
  for (const r of rows) await broadcastCourt(r.slug);
}

function attachWs(server: http.Server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  wss.on('connection', (ws, req) => {
    const u = new URL(req.url || '/', 'http://x');
    const court = u.searchParams.get('court') || '';
    const role = (['tv', 'overlay', 'score'].includes(u.searchParams.get('role') || '') ? u.searchParams.get('role') : 'viewer') as Client['role'];
    const client: Client = { ws, court, role, authed: false };
    if (role === 'score' && validToken(tokenFrom(req))) client.authed = true; // admin may score any court
    clients.add(client);
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const hb = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false; ws.ping();
      send(client, { type: 'time', serverNow: Date.now() }); // keeps clock skew estimate fresh
    }, 5000);
    ws.on('close', () => { clearInterval(hb); clients.delete(client); void broadcastCourt(court); });
    ws.on('message', async (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return send(client, { type: 'error', error: 'bad json' }); }
      try {
        if (msg.type === 'ping') return send(client, { type: 'pong', t: msg.t, serverNow: Date.now() });
        if (msg.type === 'resync') { const s = await courtSnapshot(court); return s && send(client, s); }
        if (msg.type === 'auth') {
          if (role === 'score' && (pinOk(court, msg.pin) || validToken(msg.token))) {
            client.authed = true; send(client, { type: 'auth', ok: true }); return void broadcastCourt(court);
          }
          return send(client, { type: 'auth', ok: false });
        }
        if (['cmd', 'undo', 'redo'].includes(msg.type)) {
          if (role !== 'score' || !client.authed) return send(client, { type: 'error', id: msg.id, error: 'read-only: scorekeeper PIN required' });
          const c = (await pool.query('SELECT current_game_id FROM courts WHERE slug=$1', [court])).rows[0];
          if (!c?.current_game_id) return send(client, { type: 'error', id: msg.id, error: 'no game started on this court' });
          if (msg.gameId && Number(msg.gameId) !== c.current_game_id) {
            // controller is looking at a stale game (admin switched games): refuse and resync
            send(client, { type: 'error', id: msg.id, error: 'game changed, resyncing' });
            const s = await courtSnapshot(court); return s && send(client, s);
          }
          const cmdId = typeof msg.id === 'string' ? msg.id.slice(0, 64) : null;
          let r;
          if (msg.type === 'cmd') {
            const cmd: Command = parseCommand(msg.cmd);
            r = await mutate(c.current_game_id, `pin:${court}`, cmdId, (h) => dispatch(h, cmd, Date.now()), cmd);
          } else {
            const fn = msg.type === 'undo' ? undo : redo;
            r = await mutate(c.current_game_id, `pin:${court}`, cmdId, (h) => fn(h, Date.now()), { type: msg.type.toUpperCase() });
          }
          return send(client, { type: 'ack', id: msg.id, ...r });
        }
        send(client, { type: 'error', error: 'unknown message' });
      } catch (e: any) { send(client, { type: 'error', id: msg?.id, error: String(e?.message || e) }); }
    });
    void (async () => {
      const s = await courtSnapshot(court);
      if (!s) { send(client, { type: 'error', error: `unknown court "${court}"` }); return; }
      await broadcastCourt(court); // full snapshot on (re)connect = resync
    })();
  });
}

// ---------------------------------------------------------------- http
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function json(res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function readBody(req: http.IncomingMessage, limit = 3 * 1024 * 1024): Promise<string> {
  return new Promise((ok, bad) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { bad(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', bad);
  });
}
const readJson = async (req: http.IncomingMessage) => { const t = await readBody(req); return t ? JSON.parse(t) : {}; };
const HEX = /^#[0-9a-fA-F]{6}$/;
const color = (v: any, d: string) => (typeof v === 'string' && HEX.test(v) ? v : d);

function decodeLogo(dataUrl: any): { data: Buffer; mime: string } | null {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const m = /^data:(image\/(png|jpeg|gif|webp|svg\+xml));base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('logo must be a png/jpeg/gif/webp/svg image');
  const data = Buffer.from(m[3], 'base64');
  if (data.length > 1024 * 1024) throw new Error('logo larger than 1 MB');
  return { data, mime: m[1] };
}

async function upsertTeam(b: any, id?: number) {
  const name = String(b.name || '').trim();
  if (!name) throw new Error('name required');
  const logo = decodeLogo(b.logo_data_url);
  const vals = [name, String(b.short_name || name.slice(0, 3)).toUpperCase().slice(0, 4), color(b.primary_color, '#333333'), color(b.secondary_color, '#ffffff'), b.logo_url ? String(b.logo_url) : null];
  if (id) {
    await pool.query('UPDATE teams SET name=$2, short_name=$3, primary_color=$4, secondary_color=$5, logo_url=$6 WHERE id=$1', [id, ...vals]);
    if (logo) await pool.query('UPDATE teams SET logo_data=$2, logo_mime=$3 WHERE id=$1', [id, logo.data, logo.mime]);
    if (b.remove_logo) await pool.query('UPDATE teams SET logo_data=NULL, logo_mime=NULL WHERE id=$1', [id]);
    return id;
  }
  const r = await pool.query('INSERT INTO teams(name, short_name, primary_color, secondary_color, logo_url, logo_data, logo_mime) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [...vals, logo?.data ?? null, logo?.mime ?? null]);
  return r.rows[0].id as number;
}

async function refreshAllCourts() { const { rows } = await pool.query('SELECT slug FROM courts'); for (const r of rows) await broadcastCourt(r.slug); }

async function importSchedule(text: string) {
  const rows = parseCsv(text); let created = 0; const errors: string[] = [];
  for (const [i, r] of rows.entries()) {
    try {
      const team = async (n: string) => {
        const q = await pool.query('SELECT id FROM teams WHERE lower(name)=lower($1)', [n]);
        if (!q.rows.length) throw new Error(`unknown team "${n}"`);
        return q.rows[0].id;
      };
      let court = (await pool.query('SELECT id FROM courts WHERE lower(slug)=lower($1) OR lower(name)=lower($1)', [r.court])).rows[0];
      if (!court && r.court) court = (await pool.query('INSERT INTO courts(slug,name) VALUES ($1,$2) RETURNING id', [r.court.toLowerCase().replace(/[^a-z0-9]+/g, '-'), r.court])).rows[0];
      const when = r.date ? `${r.date} ${r.time || '00:00'}` : null; // interpreted in the server's TZ
      await pool.query('INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, division) VALUES ($1,$2,$3,$4::timestamp,$5)',
        [court?.id ?? null, await team(r.home), await team(r.away), when, r.division || null]);
      created++;
    } catch (e: any) { errors.push(`row ${i + 2}: ${e.message}`); }
  }
  return { created, errors };
}

async function api(req: http.IncomingMessage, res: http.ServerResponse, u: URL): Promise<void> {
  const p = u.pathname, m = req.method || 'GET';
  const seg = p.split('/').filter(Boolean); // ['api', ...]
  if (p === '/api/health') { await pool.query('SELECT 1'); return json(res, 200, { ok: true, serverNow: Date.now() }); }
  if (p === '/api/login' && m === 'POST') {
    const b = await readJson(req);
    if (!ADMIN_PASSWORD || !safeEq(String(b.password || ''), ADMIN_PASSWORD)) return json(res, 401, { error: 'wrong password' });
    const t = makeToken();
    return json(res, 200, { token: t }, { 'set-cookie': `sb_admin=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
  }
  if (p === '/api/logout') return json(res, 200, { ok: true }, { 'set-cookie': 'sb_admin=; Path=/; Max-Age=0' });
  if (p === '/api/public/courts') {
    const { rows } = await pool.query('SELECT slug, name, location, current_game_id FROM courts ORDER BY id');
    return json(res, 200, rows);
  }
  if (seg[1] === 'public' && seg[2] === 'court' && seg[3]) {
    const s = await courtSnapshot(seg[3]);
    return s ? json(res, 200, s) : json(res, 404, { error: 'unknown court' });
  }
  // ---- everything below needs the admin session
  if (!validToken(tokenFrom(req))) return json(res, 401, { error: 'admin login required' });
  if (p === '/api/me') return json(res, 200, { role: 'admin', tz: process.env.TZ || 'UTC' });

  if (seg[1] === 'teams') {
    const id = seg[2] ? Number(seg[2]) : undefined;
    if (m === 'GET') return json(res, 200, (await pool.query('SELECT id, name, short_name, primary_color, secondary_color, logo_url, (logo_data IS NOT NULL) AS has_logo FROM teams ORDER BY name')).rows);
    if (m === 'POST') return json(res, 201, { id: await upsertTeam(await readJson(req)) });
    if (m === 'PUT' && id) { await upsertTeam(await readJson(req), id); await refreshAllCourts(); return json(res, 200, { id }); }
    if (m === 'DELETE' && id) { await pool.query('DELETE FROM teams WHERE id=$1', [id]); return json(res, 200, { ok: true }); }
  }
  if (seg[1] === 'courts') {
    const id = seg[2] ? Number(seg[2]) : undefined;
    if (m === 'GET') return json(res, 200, (await pool.query('SELECT * FROM courts ORDER BY id')).rows.map((c) => ({ ...c, has_pin: COURT_PINS.has(c.slug) })));
    if (m === 'POST') {
      const b = await readJson(req);
      const name = String(b.name || '').trim(); if (!name) throw new Error('name required');
      const slug = String(b.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const r = await pool.query('INSERT INTO courts(slug, name, location) VALUES ($1,$2,$3) RETURNING id', [slug, name, b.location || null]);
      return json(res, 201, { id: r.rows[0].id, slug });
    }
    if (m === 'DELETE' && id) { await pool.query('DELETE FROM courts WHERE id=$1', [id]); return json(res, 200, { ok: true }); }
  }
  if (seg[1] === 'games') {
    const id = seg[2] ? Number(seg[2]) : undefined;
    if (m === 'GET' && !id) {
      const { rows } = await pool.query(`SELECT g.id, g.court_id, c.name AS court, g.scheduled_at, g.division, g.status, g.theme,
        g.home_team_id, h.name AS home, g.away_team_id, a.name AS away,
        COALESCE(g.final_home, (g.history->'present'->'home'->>'score')::int, 0) AS home_score,
        COALESCE(g.final_away, (g.history->'present'->'away'->>'score')::int, 0) AS away_score,
        (c.current_game_id = g.id) AS on_court
        FROM games g JOIN teams h ON h.id=g.home_team_id JOIN teams a ON a.id=g.away_team_id LEFT JOIN courts c ON c.id=g.court_id
        ORDER BY g.scheduled_at NULLS LAST, g.id`);
      return json(res, 200, rows);
    }
    if (m === 'POST' && !id) {
      const b = await readJson(req);
      if (!b.home_team_id || !b.away_team_id || b.home_team_id === b.away_team_id) throw new Error('pick two different teams');
      const r = await pool.query('INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, division, theme, rules) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [b.court_id || null, b.home_team_id, b.away_team_id, b.scheduled_at || null, b.division || null, sanitizeTheme(b.theme), b.rules || {}]);
      return json(res, 201, { id: r.rows[0].id });
    }
    if (m === 'PUT' && id && seg.length === 3) {
      const b = await readJson(req);
      await pool.query('UPDATE games SET theme=$2 WHERE id=$1', [id, sanitizeTheme(b.theme)]);
      await broadcastGame(id); return json(res, 200, { id });
    }
    if (m === 'DELETE' && id) { runtimes.delete(id); await pool.query('DELETE FROM games WHERE id=$1', [id]); await refreshAllCourts(); return json(res, 200, { ok: true }); }
    if (m === 'POST' && id && seg[3] === 'start') {
      const g = (await pool.query('SELECT court_id FROM games WHERE id=$1', [id])).rows[0];
      if (!g?.court_id) throw new Error('assign the game to a court first');
      await pool.query('UPDATE courts SET current_game_id=$2 WHERE id=$1', [g.court_id, id]);
      await mutate(id, 'admin', null, (h) => dispatch(h, { type: 'START_GAME' }, Date.now()), { type: 'START_GAME' });
      const slug = (await pool.query('SELECT slug FROM courts WHERE id=$1', [g.court_id])).rows[0].slug;
      await broadcastCourt(slug);
      return json(res, 200, { ok: true, court: slug });
    }
    if (m === 'GET' && id && seg[3] === 'events') {
      return json(res, 200, (await pool.query('SELECT seq, actor, command, created_at FROM game_events WHERE game_id=$1 ORDER BY id', [id])).rows);
    }
  }
  if (p === '/api/export/teams.csv') {
    const { rows } = await pool.query('SELECT name, short_name, primary_color, secondary_color, logo_url FROM teams ORDER BY name');
    return csvOut(res, 'teams.csv', toCsv(['name', 'short_name', 'primary_color', 'secondary_color', 'logo_url'], rows));
  }
  if (p === '/api/export/schedule.csv') {
    const { rows } = await pool.query(`SELECT to_char(g.scheduled_at AT TIME ZONE current_setting('TimeZone'),'YYYY-MM-DD') AS date,
      to_char(g.scheduled_at AT TIME ZONE current_setting('TimeZone'),'HH24:MI') AS time, COALESCE(c.slug,'') AS court, g.division,
      h.name AS home, a.name AS away, g.final_home AS home_score, g.final_away AS away_score, g.status
      FROM games g JOIN teams h ON h.id=g.home_team_id JOIN teams a ON a.id=g.away_team_id LEFT JOIN courts c ON c.id=g.court_id
      ORDER BY g.scheduled_at NULLS LAST, g.id`);
    return csvOut(res, 'schedule.csv', toCsv(['date', 'time', 'court', 'division', 'home', 'away', 'home_score', 'away_score', 'status'], rows));
  }
  if (p === '/api/import/teams.csv' && m === 'POST') {
    const rows = parseCsv(await readBody(req)); let n = 0; const errors: string[] = [];
    for (const [i, r] of rows.entries()) {
      try {
        const ex = (await pool.query('SELECT id FROM teams WHERE lower(name)=lower($1)', [r.name])).rows[0];
        await upsertTeam(r, ex?.id); n++;
      } catch (e: any) { errors.push(`row ${i + 2}: ${e.message}`); }
    }
    await refreshAllCourts(); return json(res, 200, { upserted: n, errors });
  }
  if (p === '/api/export/courts.csv') {
    const { rows } = await pool.query('SELECT slug, name, location FROM courts ORDER BY id');
    return csvOut(res, 'courts.csv', toCsv(['slug', 'name', 'location'], rows));
  }
  if (p === '/api/import/courts.csv' && m === 'POST') {
    // Upsert by slug (slug is what URLs, PINs and schedule.csv "court" refer to).
    const rows = parseCsv(await readBody(req)); let n = 0; const errors: string[] = [];
    for (const [i, r] of rows.entries()) {
      try {
        const name = (r.name || '').trim();
        const slug = (r.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!slug || !name) throw new Error('slug/name required');
        await pool.query(`INSERT INTO courts(slug, name, location) VALUES ($1,$2,$3)
          ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, location=EXCLUDED.location`, [slug, name, r.location || null]);
        n++;
      } catch (e: any) { errors.push(`row ${i + 2}: ${e.message}`); }
    }
    await refreshAllCourts(); return json(res, 200, { upserted: n, errors });
  }
  if (p === '/api/import/schedule.csv' && m === 'POST') { const r = await importSchedule(await readBody(req)); await refreshAllCourts(); return json(res, 200, r); }
  json(res, 404, { error: 'not found' });
}

function sanitizeTheme(t: any) {
  const o: Record<string, string> = {};
  if (!t || typeof t !== 'object') return o;
  for (const side of ['home', 'away']) {
    if (t[`${side}Name`]) o[`${side}Name`] = String(t[`${side}Name`]).slice(0, 30);
    if (HEX.test(t[`${side}Color`] || '')) o[`${side}Color`] = t[`${side}Color`];
    if (HEX.test(t[`${side}Accent`] || '')) o[`${side}Accent`] = t[`${side}Accent`];
    if (/^(https?:\/\/|\/)/.test(t[`${side}Logo`] || '')) o[`${side}Logo`] = String(t[`${side}Logo`]);
  }
  return o;
}
function csvOut(res: http.ServerResponse, name: string, body: string) {
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` });
  res.end(body);
}

const PAGES: [RegExp, string][] = [
  [/^\/$/, 'index.html'], [/^\/admin\/?$/, 'admin.html'],
  [/^\/score\/[\w-]+\/?$/, 'score.html'], [/^\/tv\/[\w-]+\/?$/, 'tv.html'], [/^\/overlay\/[\w-]+\/?$/, 'overlay.html'],
];

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  try {
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    const lm = /^\/logos\/(\d+)$/.exec(u.pathname);
    if (lm) {
      const r = (await pool.query('SELECT logo_data, logo_mime FROM teams WHERE id=$1', [Number(lm[1])])).rows[0];
      if (!r?.logo_data) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': r.logo_mime, 'cache-control': 'public, max-age=60', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return res.end(r.logo_data);
    }
    const page = PAGES.find(([re]) => re.test(u.pathname));
    let file = page ? page[1] : u.pathname.replace(/^\/+/, '');
    const full = path.resolve(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const code = /duplicate key/.test(msg) ? 409 : /foreign key/.test(msg) ? 400 : /required|must|pick|larger|assign|JSON|too large|unknown/.test(msg) ? 400 : 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) json(res, code, { error: code === 500 ? 'server error' : msg });
    else res.end();
  }
});

async function main() {
  for (let i = 0; ; i++) {
    try { await migrate(); break; } catch (e) {
      if (i >= 30) throw e;
      console.log('waiting for Postgres...'); await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (process.env.SEED === 'true' && (await seedIfEmpty())) console.log('Seeded demo teams, courts and games.');
  attachWs(server);
  server.listen(PORT, () => console.log(`Scoreboard listening on :${PORT}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
