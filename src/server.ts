// UpwardScoreboard: one Node process serves the web UI, REST API and
// WebSocket realtime channel. Postgres is the only other moving part.
import './test-clock.js'; // first: test-only clock override (SCOREBOARD_TEST_NOW)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { normHex, COLOR_HELP } from './color.js';
import { pool, migrate, migrateColors, seedIfEmpty, seedDemo, legacyCheerConflicts, squadId, setSlotSquad, gameSlot, slotDateSql, slotStartSql } from './db.js';
import { scorekeeperView, publicView } from './payload.js';
import { parseCsvTable, toCsv } from './csv.js';
import { Limiter } from './limits.js';
import { GAME_MINUTES, parseConflicts, normalizeGrade, gradeOrder, gradeMismatch, sideOf, normalizeGender, genderMismatch, divisionLabel, isScoreHiddenGrade, scheduleWarnings, resolveScheduleDay, localDate, LEAGUE_TZ, WarnGame, hourSlot, cheerSlotWarnings, gameTimeErrors, isIsoDate } from './schedule.js';
import { HttpError, decodeLogo, safeLogoUrl } from './logo.js';
import { logoFile, loadLogos, formatReport } from './logo-files.js';
import { loadPractice, validatePractice, savePractice, droppedSlots } from './practice.js';
import {
  History, Command, newHistory, initialState, dispatch, undo, redo, parseCommand, remainingMs, isBonus, normalizeStatus,
  hiddenGameRefusal, isTeamStatCommand,
} from './game.js';
import QRCode from 'qrcode';
import { makeQrToken, verifyQrToken, weekEnd } from './qr.js';

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const LEAGUE_NAME = process.env.LEAGUE_NAME || 'Lenexa Baptist Church Youth Basketball';
const CHURCH_NAME = process.env.CHURCH_NAME || 'Lenexa Baptist Church';
// Optional church logo for the TV/overlay header: an http(s) URL or a path under /public (e.g. /church-logo.png).
const CHURCH_LOGO_URL = (() => { const v = (process.env.CHURCH_LOGO_URL || '').trim(); return /^\/[\w./-]+$/.test(v) && !v.includes('..') ? v : (/^https?:\/\//i.test(v) ? v : null); })();
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
// Brute-force protection (QA r2-A: never lock out a whole gym).
// - PIN failures are counted per court + device (client-generated id) and per socket: 5 -> lock/close.
// - Only a much higher per-IP backstop (100 wrong PINs) applies across devices (gym phones share one NAT IP),
//   so one kid guessing on East can't lock West. Devices holding a valid court session token skip all limits.
// - Bad QR codes count per device only, never toward the IP backstop: a signed QR can't be guessed, so a
//   spare phone scanning junk can lock only itself. A valid QR token is accepted even while the IP is backstopped.
// - Admin login: 5 failures per IP. Lockouts double (30s, 60s, ... max 15 min).
const LOCK_BASE_MS = Number(process.env.RATE_LIMIT_BASE_MS || 30_000);
const pinDeviceLimiter = new Limiter(5, LOCK_BASE_MS);
const pinIpBackstop = new Limiter(Number(process.env.PIN_IP_BACKSTOP || 100), LOCK_BASE_MS);
const loginLimiter = new Limiter(5, LOCK_BASE_MS);
const SOCKET_MAX_PIN_FAILS = 5;
const REVOKED_MSG = "This phone was signed in with a court QR code that has been replaced. Scan the new code or enter the court PIN.";
setInterval(() => { pinDeviceLimiter.prune(); pinIpBackstop.prune(); loginLimiter.prune(); }, 600_000).unref();

// Court session tokens: HMAC-signed "court.expiry.sig", 12 h, scoped to one court. Issued after a
// correct PIN, kept in the device's localStorage, used on every reconnect instead of the PIN.
const SESSION_MS = 12 * 3600_000;
// Sessions from a QR sign-in carry the court's qr_version ("court.exp.q<ver>.sig"): Regenerate/Revoke bumps the
// version, which ends those sessions. PIN sessions ("court.exp.p.sig", or the older "court.exp.sig") stay valid.
function makeCourtSession(court: string, qrVer: number | null = null): string {
  const exp = String(Date.now() + SESSION_MS), how = qrVer == null ? 'p' : `q${qrVer}`;
  return `${court}.${exp}.${how}.${sign(`court:${court}:${exp}:${how}`)}`;
}
/** Parsed, signature-checked court session, or null. qrVer is null for PIN sessions. */
function parseCourtSession(t: unknown, court: string): { qrVer: number | null } | null {
  if (typeof t !== 'string' || t.length > 200 || !t.startsWith(court + '.')) return null;
  const parts = t.slice(court.length + 1).split('.');
  if (parts.length === 2) { // pre-QR format: court.exp.sig (PIN)
    const [exp, sig] = parts;
    return Number(exp) > Date.now() && safeEq(sig, sign(`court:${court}:${exp}`)) ? { qrVer: null } : null;
  }
  if (parts.length !== 3) return null;
  const [exp, how, sig] = parts;
  if (!(Number(exp) > Date.now()) || !/^(p|q\d+)$/.test(how) || !safeEq(sig, sign(`court:${court}:${exp}:${how}`))) return null;
  return { qrVer: how === 'p' ? null : Number(how.slice(1)) };
}
function clientIp(req: http.IncomingMessage): string {
  if (process.env.TRUST_PROXY === 'true') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}
const pinOk = (court: string, pin: unknown) => typeof pin === 'string' && COURT_PINS.has(court) && safeEq(pin, COURT_PINS.get(court)!);

// ------------------------------------------------------------- game runtime
interface Runtime { history: History; queue: Promise<unknown>; timer?: NodeJS.Timeout; seen: string[]; }
const runtimes = new Map<number, Runtime>();

async function getRuntime(gameId: number): Promise<Runtime> {
  let rt = runtimes.get(gameId);
  if (rt) return rt;
  const { rows } = await pool.query('SELECT history, rules, status, final_home, final_away FROM games WHERE id=$1', [gameId]);
  if (!rows.length) throw new Error('game not found');
  rt = runtimes.get(gameId); // another caller may have loaded it meanwhile
  if (rt) return rt;
  // A3: a game that never ran here (e.g. completed by CSV import) has no history, only final_home/final_away. Start its
  // state from that stored final, so Reopen continues 10–16 LIVE instead of 0–0.
  const fresh = () => { const st = initialState(rows[0].rules || {}); if (rows[0].final_home != null) st.home.score = rows[0].final_home; if (rows[0].final_away != null) st.away.score = rows[0].final_away; return newHistory(st); };
  const h: History = normalizeStatus(rows[0].history) ?? fresh();
  h.present.status = rows[0].status; // the games.status column is authoritative (imports, migrations)
  rt = { history: h, queue: Promise.resolve(), seen: [] };
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
    // Complete locks the final score: no commands, no undo/redo. Only an admin REOPEN gets through.
    if (before.present.status === 'complete' && (logged as any)?.type !== 'REOPEN') throw new HttpError(409, 'This game is complete. The final score is locked (an admin can reopen it).');
    const after = op(before);
    if (cmdId) { rt.seen.push(cmdId); if (rt.seen.length > 500) rt.seen.shift(); }
    if (after === before) return { seq: before.present.seq };
    const p = after.present;
    await pool.query(
      `UPDATE games SET history=$2, status=$3, final_home=$4, final_away=$5, updated_at=now() WHERE id=$1`,
      [gameId, after, p.status, p.status === 'complete' ? p.home.score : null, p.status === 'complete' ? p.away.score : null]);
    await pool.query('INSERT INTO game_events(game_id, seq, client_cmd_id, actor, command) VALUES ($1,$2,$3,$4,$5)',
      [gameId, p.seq, cmdId, actor, JSON.stringify(logged)]);
    rt.history = after;
    armClock(gameId, rt);
    if (p.status === 'complete' && before.present.status !== 'complete') {
      // court goes idle ("Next up") the moment a game is completed
      const { rows } = await pool.query('UPDATE courts SET current_game_id=NULL WHERE current_game_id=$1 RETURNING slug', [gameId]);
      for (const r of rows) await broadcastCourt(r.slug);
    } else await broadcastGame(gameId);
    return { seq: p.seq };
  });
  rt.queue = run.catch(() => undefined);
  return run;
}

/** K-2nd Grade game (score-hidden): the grade text of either team, via isScoreHiddenGrade. */
async function gameHidesScore(gameId: number): Promise<boolean> {
  const { rows } = await pool.query('SELECT COALESCE(h.grade, a.grade) AS grade FROM games g JOIN teams h ON h.id=g.home_team_id JOIN teams a ON a.id=g.away_team_id WHERE g.id=$1', [gameId]);
  return isScoreHiddenGrade(rows[0]?.grade);
}

// ------------------------------------------------------------ view models
// Season colors: every team wears the season's dark or light color. Default home = light, away = dark;
// games.swap_colors flips it. Advanced per-matchup theme colors (Admin > game > Advanced) still win.
let season = { name: '2026–27 Upward', dark: '#800000', light: '#FFC72C' };
async function loadSeason() {
  const { rows } = await pool.query(`SELECT key, value FROM settings WHERE key IN ('season_name','season_dark','season_light')`);
  for (const r of rows) (season as any)[r.key.slice(7)] = r.value;
}
/** Relative luminance (WCAG) for server-side season validation. */
const lum = (h: string) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
/** The cheer squad of the game's time slot (one per hour, shared by every court), or null. Coach = first name only. */
function cheerView(r: any) {
  if (!r.cheer_squad_id) return null;
  return { squadId: r.cheer_squad_id, name: r.cheer_squad, logo: r.cheer_squad_has_logo ? `/logos/squad/${r.cheer_squad_id}` : r.cheer_squad_logo_url || null,
    coach: r.cheer_coach || null, locker: r.cheer_locker || null, slot: { date: r.cheer_slot_date, start: r.cheer_slot_start } };
}
function teamView(r: any, prefix: string, theme: any, side: 'home' | 'away') {
  const id = r[`${prefix}_id`];
  const wear = sideOf(r.swap_colors, side);
  return {
    id,
    name: theme[`${side}Name`] || r[`${prefix}_name`],
    short: r[`${prefix}_short`] || r[`${prefix}_name`]?.slice(0, 3).toUpperCase(),
    side: wear,
    color: theme[`${side}Color`] || season[wear],
    accent: theme[`${side}Accent`] || season[wear === 'light' ? 'dark' : 'light'],
    logo: theme[`${side}Logo`] || (r[`${prefix}_has_logo`] ? `/logos/${id}` : r[`${prefix}_logo_url`] || null),
    locker: r[`${side}_locker`] || null, // per game (changes weekly)
    coach: r[`${side}_coach`] || null, // first name; never sent to the scorekeeper (see scorekeeperView)
  };
}

/** League time zone as a SQL literal (from TZ; only zone-name characters are allowed). */
const TZ_SQL = `'${/^[A-Za-z0-9_\/+-]+$/.test(LEAGUE_TZ) ? LEAGUE_TZ : 'America/Chicago'}'`;
/** Joins a game row g to its cheer slot (league date + start floored to the hour) and squad. */
const CHEER_JOIN = `LEFT JOIN cheer_slots cs ON cs.date = ${slotDateSql('g.scheduled_at', TZ_SQL)} AND cs.slot_start = ${slotStartSql('g.scheduled_at', TZ_SQL)}
  LEFT JOIN cheer_squads cq ON cq.id = cs.squad_id`;
const GAME_SELECT = `
  SELECT g.*, c.slug AS court_slug, c.name AS court_name,
    h.grade AS home_grade, a.grade AS away_grade, h.gender AS home_gender, a.gender AS away_gender,
    h.name AS home_name, h.short_name AS home_short, h.primary_color AS home_primary, h.secondary_color AS home_secondary,
    h.logo_url AS home_logo_url, (h.logo_data IS NOT NULL) AS home_has_logo,
    a.name AS away_name, a.short_name AS away_short, a.primary_color AS away_primary, a.secondary_color AS away_secondary,
    a.logo_url AS away_logo_url, (a.logo_data IS NOT NULL) AS away_has_logo,
    h.coach AS home_coach, a.coach AS away_coach,
    cs.id AS cheer_slot_id, to_char(cs.date, 'YYYY-MM-DD') AS cheer_slot_date, to_char(cs.slot_start, 'HH24:MI') AS cheer_slot_start, cs.locker AS cheer_locker,
    cq.id AS cheer_squad_id, cq.name AS cheer_squad, cq.coach AS cheer_coach, cq.logo_url AS cheer_squad_logo_url, (cq.logo_data IS NOT NULL) AS cheer_squad_has_logo
  FROM games g JOIN teams h ON h.id=g.home_team_id JOIN teams a ON a.id=g.away_team_id
  LEFT JOIN courts c ON c.id=g.court_id
  ${CHEER_JOIN}`;

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
  // Displays always show the court's ACTIVE game; with none, an idle "Next up" screen.
  const active = (await pool.query(`SELECT id FROM games WHERE court_id=$1 AND status='active'`, [c.id])).rows[0];
  const game = active ? await gameViewNorm(active.id) : null;
  const NOW = new Date(); // app clock, not SQL now(): the test clock (SCOREBOARD_TEST_NOW) must shift "today" too
  const lite = `SELECT g.id, g.status, to_char(g.scheduled_at AT TIME ZONE current_setting('TimeZone'), 'HH24:MI') AS time,
      to_char(g.scheduled_at AT TIME ZONE current_setting('TimeZone'), 'Dy Mon FMDD') AS day, (g.scheduled_at::date = $2::timestamptz::date) AS is_today,
      COALESCE(h.grade, a.grade) AS grade, concat_ws(' ', COALESCE(h.grade, a.grade), COALESCE(h.gender, a.gender)) AS label, h.name AS home, a.name AS away, g.home_locker, g.away_locker, g.final_home, g.final_away
    FROM games g JOIN teams h ON h.id=g.home_team_id JOIN teams a ON a.id=g.away_team_id WHERE g.court_id=$1`;
  const nextUp = (await pool.query(`${lite} AND g.status='scheduled' AND g.scheduled_at >= date_trunc('day', $2::timestamptz) ORDER BY g.scheduled_at, g.id LIMIT 1`, [c.id, NOW])).rows[0] || null;
  const lastFinal = (await pool.query(`${lite} AND g.status='complete' AND g.scheduled_at::date = $2::timestamptz::date ORDER BY g.updated_at DESC LIMIT 1`, [c.id, NOW])).rows[0] || null;
  // Scorekeeper game picker: today's games on this court that aren't complete. With none today, the court's next
  // game day within a week (e.g. the demo weekend on a weekday); those rows carry is_today=false + day.
  let today = (await pool.query(`${lite} AND g.status <> 'complete' AND g.scheduled_at::date = $2::timestamptz::date ORDER BY g.scheduled_at, g.id`, [c.id, NOW])).rows;
  if (!today.length) today = (await pool.query(`${lite} AND g.status <> 'complete' AND g.scheduled_at::date = (SELECT min(x.scheduled_at::date) FROM games x
      WHERE x.court_id=$1 AND x.status <> 'complete' AND x.scheduled_at::date > $2::timestamptz::date AND x.scheduled_at < $2::timestamptz + interval '7 days') ORDER BY g.scheduled_at, g.id`, [c.id, NOW])).rows;
  const upNext = (await pool.query(
    `SELECT g.id, to_char(g.scheduled_at AT TIME ZONE current_setting('TimeZone'), 'HH24:MI') AS time,
       to_char(g.scheduled_at AT TIME ZONE current_setting('TimeZone'), 'Dy Mon FMDD') AS day, (g.scheduled_at::date = $3::timestamptz::date) AS is_today, h.name AS home, a.name AS away, g.home_locker, g.away_locker, COALESCE(h.grade, a.grade) AS grade, concat_ws(' ', COALESCE(h.grade, a.grade), COALESCE(h.gender, a.gender)) AS label
     FROM games g JOIN teams h ON h.id=g.home_team_id JOIN teams a ON a.id=g.away_team_id
     WHERE g.court_id=$1 AND g.status='scheduled' AND g.id IS DISTINCT FROM $2 AND g.scheduled_at >= date_trunc('day', $3::timestamptz)
     ORDER BY g.scheduled_at NULLS LAST, g.id LIMIT 3`, [c.id, active?.id ?? null, NOW])).rows;
  // Young grades (2nd and below): flag rows so publicView() strips their scores for non-scorekeeper clients.
  const flag = (x: any) => (x ? Object.assign(x, { hideScore: isScoreHiddenGrade(x.grade) }) : x);
  [nextUp, lastFinal, ...today, ...upNext].forEach(flag);
  return { type: 'state', serverNow: Date.now(), league: LEAGUE_NAME, church: { name: CHURCH_NAME, logo: CHURCH_LOGO_URL }, season, court: { slug: c.slug, name: c.name }, game, upNext, nextUp, lastFinal, today };
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
    homeSide: sideOf(r.swap_colors, 'home'), swapped: !!r.swap_colors, grade: r.home_grade || r.away_grade || null,
    gender: r.home_gender || r.away_gender || null, label: divisionLabel(r.home_grade || r.away_grade, r.home_gender || r.away_gender),
    hideScore: isScoreHiddenGrade(r.home_grade || r.away_grade), // 2nd Grade and below: public screens show no score
    cheer: cheerView(r),
    home: { ...teamView(r, 'home_team', theme, 'home'), bonus: isBonus(s, 'home') },
    away: { ...teamView(r, 'away_team', theme, 'away'), bonus: isBonus(s, 'away') },
    state: s, canUndo: rt.history.past.length > 0, canRedo: rt.history.future.length > 0,
    redoLabel: rt.history.future[0]?.lastLabel ?? null, // QA L(a): K-2nd scorekeeper disables Redo of a score/foul/timeout
  };
}

// -------------------------------------------------------------- websockets
interface Client { ws: WebSocket; court: string; role: 'tv' | 'overlay' | 'score' | 'viewer' | 'schedule'; authed: boolean; qrVer?: number | null; date?: string; }
const clients = new Set<Client>();

/**
 * Scorekeepers never get cheer squad data (TV/overlay only) nor any coach name (deep-stripped). Everyone else
 * (tv, overlay, viewer, lobby/schedule) gets publicView: no scores for 2nd Grade and below.
 */
function forRole(c: Client, msg: any) {
  return c.role === 'score' ? scorekeeperView(msg) : publicView(msg);
}
function send(c: Client, msg: unknown) { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(forRole(c, msg))); }

// Schedule screens subscribe to every court: any court broadcast (score, status, load/complete) or schedule
// change (import, edit, delete, season) refreshes them, coalesced to one snapshot per day every 150 ms.
let scheduleTimer: NodeJS.Timeout | null = null;
function scheduleChanged() {
  if (scheduleTimer || ![...clients].some((c) => c.role === 'schedule')) return;
  scheduleTimer = setTimeout(async () => {
    scheduleTimer = null;
    const byDate = new Map<string, Client[]>();
    for (const c of clients) if (c.role === 'schedule' && c.date) byDate.set(c.date, [...(byDate.get(c.date) || []), c]);
    for (const [date, list] of byDate) { try { const snap = await scheduleSnapshot(date); for (const c of list) send(c, snap); } catch (e) { console.error(e); } }
  }, 150);
}
async function broadcastCourt(slug: string) {
  scheduleChanged();
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
    const role = (['tv', 'overlay', 'score', 'schedule'].includes(u.searchParams.get('role') || '') ? u.searchParams.get('role') : 'viewer') as Client['role'];
    const client: Client = { ws, court, role, authed: false };
    if (role === 'schedule') client.date = resolveScheduleDay({ day: u.searchParams.get('day'), date: u.searchParams.get('date') }, Date.now());
    if (role === 'score' && validToken(tokenFrom(req))) client.authed = true; // admin may score any court
    clients.add(client);
    // Heartbeat: ping every 2s; if nothing (pong or message) for ~3.5s the peer is gone
    // (half-open socket after a silent network drop) -> terminate so presence is accurate.
    const ip = clientIp(req);
    let lastSeen = Date.now(), pinFails = 0;
    ws.on('pong', () => { lastSeen = Date.now(); });
    let lastTick = Date.now();
    const hb = setInterval(() => {
      const now = Date.now(), stalled = now - lastTick > 3000; lastTick = now;
      // If our own event loop was stalled (GC, host suspend), give peers one more round to answer.
      if (stalled) lastSeen = Math.max(lastSeen, now - 2000);
      else if (now - lastSeen > 3500) return ws.terminate();
      ws.ping();
      send(client, { type: 'time', serverNow: Date.now() }); // also feeds the client-side watchdog
    }, 2000);
    ws.on('close', () => { clearInterval(hb); clients.delete(client); if (role !== 'schedule') void broadcastCourt(court); });
    ws.on('message', async (raw) => {
      lastSeen = Date.now();
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return send(client, { type: 'error', error: 'bad json' }); }
      try {
        if (msg.type === 'ping') return send(client, { type: 'pong', t: msg.t, serverNow: Date.now() });
        if (msg.type === 'resync') { const s = role === 'schedule' ? await scheduleSnapshot(client.date!) : await courtSnapshot(court); return s && send(client, s); }
        if (role === 'schedule') return send(client, { type: 'error', error: 'read-only schedule screen' });
        if (msg.type === 'auth') {
          // Displays are read-only: an auth attempt there is refused but never counted.
          if (role !== 'score') return send(client, { type: 'auth', ok: false, error: 'This is a read-only display link.' });
          const welcome = (session: string | null, how: string, qrVer: number | null = null) => {
            client.authed = true; client.qrVer = qrVer; pinFails = 0;
            send(client, { type: 'auth', ok: true, how, ...(session ? { session } : {}) });
            return void broadcastCourt(court);
          };
          // 1) Session token or admin token: no PIN, no limiter, never locked out.
          const sess = parseCourtSession(msg.session, court);
          let sessionRevoked = false;
          if (sess) {
            if (sess.qrVer == null) return welcome(null, 'session');
            const cur = (await pool.query('SELECT qr_version FROM courts WHERE slug=$1', [court])).rows[0]?.qr_version;
            if (cur === sess.qrVer) return welcome(null, 'session', sess.qrVer);
            sessionRevoked = true;
          }
          if (validToken(msg.token)) return welcome(null, 'admin');
          if (msg.pin == null && msg.qr == null) return send(client, { type: 'auth', ok: false, needPin: true, sessionRevoked,
            error: sessionRevoked ? REVOKED_MSG : msg.session ? 'Session expired. Enter the PIN.' : 'Enter the PIN.' });
          // 2) Weekly QR token or PIN: limited per court + device and per socket, with a high per-IP backstop.
          const dev = typeof msg.device === 'string' && /^[\w-]{8,64}$/.test(msg.device) ? msg.device : `sock-${ip}-${court}`;
          const devKey = `pin:${court}:${dev}`, ipKey = `pinip:${ip}`;
          const isQr = msg.qr != null;
          const lockText = (ms: number) => isQr
            ? `Too many invalid QR codes on this phone. Try again in ${Math.ceil(ms / 1000)} s, or enter the court PIN after that.`
            : `Too many wrong PINs. Try again in ${Math.ceil(ms / 1000)} s.`;
          const locked = (ms: number) => send(client, { type: 'auth', ok: false, locked: true, cause: isQr ? 'qr' : 'pin', retryAfter: Math.ceil(ms / 1000), error: lockText(ms) });
          // The IP backstop only gates PIN guesses; a valid signed QR token is never blocked by it.
          const wait = Math.max(pinDeviceLimiter.retryAfter(devKey), isQr ? 0 : pinIpBackstop.retryAfter(ipKey));
          if (wait) return locked(wait);
          let qrError: string | null = null, qrReason: string | null = null;
          if (msg.qr != null) {
            const ver = (await pool.query('SELECT qr_version FROM courts WHERE slug=$1', [court])).rows[0]?.qr_version ?? -1;
            const chk = verifyQrToken(SESSION_SECRET, msg.qr, court, Date.now(), ver);
            if (chk.ok) { pinDeviceLimiter.succeed(devKey); return welcome(makeCourtSession(court, ver), 'qr', ver); }
            qrReason = chk.reason;
            qrError = chk.reason === 'expired' ? "This court's QR code has expired (codes are good until Sunday night). Scan this week's code or enter the PIN."
              : chk.reason === 'revoked' ? 'This QR code was replaced by a newer one. Scan the new code or enter the PIN.'
              : "This QR code isn't valid for this court. Scan the court's code or enter the PIN.";
          } else if (pinOk(court, msg.pin)) { pinDeviceLimiter.succeed(devKey); pinIpBackstop.succeed(ipKey); return welcome(makeCourtSession(court), 'pin'); }
          const lockMs = Math.max(pinDeviceLimiter.fail(devKey), isQr ? 0 : pinIpBackstop.fail(ipKey));
          pinFails++;
          if (lockMs) locked(lockMs);
          else if (qrError) send(client, { type: 'auth', ok: false, qrInvalid: true, reason: qrReason, needPin: true, error: qrError });
          else send(client, { type: 'auth', ok: false, error: `Wrong PIN (${SOCKET_MAX_PIN_FAILS - pinFails} ${SOCKET_MAX_PIN_FAILS - pinFails === 1 ? 'try' : 'tries'} left)` });
          if (pinFails >= SOCKET_MAX_PIN_FAILS) {
            const ms = Math.max(pinDeviceLimiter.retryAfter(devKey), LOCK_BASE_MS);
            send(client, { type: 'auth', ok: false, locked: true, cause: isQr ? 'qr' : 'pin', retryAfter: Math.ceil(ms / 1000), error: lockText(ms) });
            ws.close(4008, isQr ? 'too many QR attempts' : 'too many PIN attempts');
          }
          return;
        }
        if (msg.type === 'load') { // scorekeeper picked a game from today's list
          if (role !== 'score' || !client.authed) return send(client, { type: 'error', id: msg.id, error: 'read-only: scorekeeper PIN required' });
          const gid = await activateGame(Number(msg.gameId), court, `pin:${court}`, false);
          return send(client, { type: 'ack', id: msg.id, loaded: gid });
        }
        if (['cmd', 'undo', 'redo'].includes(msg.type)) {
          if (role !== 'score' || !client.authed) return send(client, { type: 'error', id: msg.id, error: 'read-only: scorekeeper PIN required' });
          const c = (await pool.query(`SELECT g.id AS current_game_id FROM courts c JOIN games g ON g.court_id=c.id AND g.status='active' WHERE c.slug=$1`, [court])).rows[0];
          if (!c?.current_game_id) return send(client, { type: 'error', id: msg.id, error: 'No game is loaded on this court. Pick a game first.' });
          if (msg.gameId && Number(msg.gameId) !== c.current_game_id) {
            // controller is looking at a stale game (admin switched games): refuse and resync
            send(client, { type: 'error', id: msg.id, error: 'game changed, resyncing' });
            const s = await courtSnapshot(court); return s && send(client, s);
          }
          const cmdId = typeof msg.id === 'string' ? msg.id.slice(0, 64) : null;
          let r;
          // K-2nd Grade: no scores, fouls or timeouts, also for a stale client still showing those buttons.
          // QA L(d): decide by the raw type first, so a malformed SCORE/FOUL/TIMEOUT also gets code score-hidden.
          const hides = await gameHidesScore(c.current_game_id);
          const rawType = { type: String(msg.cmd?.type ?? '').trim().toUpperCase() };
          if (hides && msg.type === 'cmd' && isTeamStatCommand(rawType as any))
            return send(client, { type: 'error', id: msg.id, error: hiddenGameRefusal('cmd', rawType, newHistory(initialState()))!, code: 'score-hidden' });
          const parsed: Command | null = msg.type === 'cmd' ? parseCommand(msg.cmd) : null;
          if (hides) {
            const no = hiddenGameRefusal(msg.type, parsed, (await getRuntime(c.current_game_id)).history);
            if (no) return send(client, { type: 'error', id: msg.id, error: no, code: 'score-hidden' });
          }
          if (msg.type === 'cmd') {
            const cmd: Command = parsed!;
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
      if (role === 'schedule') return send(client, await scheduleSnapshot(client.date!));
      const s = await courtSnapshot(court);
      if (!s) { send(client, { type: 'error', error: `unknown court "${court}"` }); return; }
      await broadcastCourt(court); // full snapshot on (re)connect = resync
    })();
  });
}

// ---------------------------------------------------------------- http
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8' };

function json(res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
const TOO_LARGE = 'Upload too large. Logos must be 1 MB or smaller; CSV files 2 MB or smaller.';
/** Read a request body. Oversized bodies are drained (not reset) and rejected with a clean 413. */
function readBody(req: http.IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return new Promise((ok, bad) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > 20 * 1024 * 1024) return bad(new HttpError(413, TOO_LARGE)); // absurd: don't even drain
    let size = 0, over = false; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { over = true; chunks.length = 0; } else if (!over) chunks.push(c); });
    req.on('end', () => (over ? bad(new HttpError(413, TOO_LARGE)) : ok(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', bad);
  });
}
const readJson = async (req: http.IncomingMessage) => {
  const t = await readBody(req);
  try { return t ? JSON.parse(t) : {}; } catch { throw new HttpError(400, 'Request body is not valid JSON'); }
};
/** Strict color: empty -> d, #RGB / #RRGGBB (any case) -> uppercase #RRGGBB, anything else -> 400. */
function color(v: any, d: string | null, field: string): string | null {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
  if (!s) return d;
  const h = normHex(s);
  if (!h) throw new HttpError(400, `${field} "${s.slice(0, 20)}" is not a color; ${COLOR_HELP}`);
  return h;
}

const genderOf = (v: unknown) => { try { return normalizeGender(v); } catch (e: any) { throw new HttpError(400, e.message); } };
const gradeOf = (v: unknown) => { try { return normalizeGrade(v); } catch (e: any) { throw new HttpError(400, e.message); } };
function teamValues(b: any, strictColors = true) {
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, 'name required');
  if (name.length > 30) throw new HttpError(400, 'name longer than 30 characters');
  // Team colors are no longer used (season colors apply); kept only when a valid one is sent.
  // API: a bad color is a 400; teams.csv (old files with color columns): bad colors are ignored as before.
  const opt = (v: any, f: string) => (strictColors ? color(v, null, f) : normHex(v));
  return [name, String(b.short_name || name.slice(0, 3)).trim().toUpperCase().slice(0, 4), opt(b.primary_color, 'primary_color'),
    opt(b.secondary_color, 'secondary_color'), safeLogoUrl(b.logo_url), gradeOf(b.grade), genderOf(b.gender)] as const;
}
/** Resolve a team by name (+ optional grade). Without a grade the name must be unambiguous. */
async function findTeam(name: string, grade: string | null, gender: string | null = null): Promise<{ id: number; grade: string | null; gender: string | null } | { error: string } | null> {
  let { rows } = await pool.query('SELECT id, grade, gender FROM teams WHERE lower(name)=lower($1) ORDER BY grade_order, grade, gender', [name]);
  const all = rows;
  if (gender) { const g = rows.filter((t) => t.gender === gender || t.gender == null); rows = g.length ? g : rows; }
  if (grade) {
    const inGrade = rows.filter((t) => (t.grade ?? null) === grade);
    if (inGrade.length > 1) return { error: `"${name}" exists in ${grade} ${inGrade.map((t) => t.gender || 'no gender').join(' and ')}; fill the gender column` };
    return inGrade[0] ?? (all.length === 1 ? all[0] : null); // single team elsewhere: the grade/gender check explains the mismatch
  }
  if (rows.length > 1) return { error: `"${name}" exists in ${rows.map((t) => divisionLabel(t.grade, t.gender) || 'no grade').join(' and ')}; fill the grade (and gender) column` };
  return rows[0] ?? null;
}
const dupTeam = (e: any, b: any) => /teams_grade_gender_name_uk|teams_grade_name_uk|teams_name_key/.test(e.message)
  ? new HttpError(409, `A team named "${String(b.name || '').trim()}" already exists${divisionLabel(gradeOf(b.grade), genderOf(b.gender)) ? ' in ' + divisionLabel(gradeOf(b.grade), genderOf(b.gender)) : ''}. Team names must be unique within a grade and gender.`) : e;
async function upsertTeam(b: any, id?: number, strictColors = true) {
  try { return await upsertTeamRaw(b, id, strictColors); } catch (e: any) { throw dupTeam(e, b); }
}
async function upsertTeamRaw(b: any, id?: number, strictColors = true) {
  const vals = teamValues(b, strictColors);
  coachOf(b.coach); // validate before any write
  const logo = decodeLogo(b.logo_data_url);
  if (id) {
    await pool.query('UPDATE teams SET name=$2, short_name=$3, primary_color=COALESCE($4, primary_color), secondary_color=COALESCE($5, secondary_color), logo_url=$6 WHERE id=$1', [id, ...vals.slice(0, 5)]);
    if ('grade' in b) await pool.query('UPDATE teams SET grade=$2, grade_order=$3 WHERE id=$1', [id, vals[5], gradeOrder(vals[5])]);
    if ('gender' in b) await pool.query('UPDATE teams SET gender=$2 WHERE id=$1', [id, vals[6]]);
    if ('coach' in b) await pool.query('UPDATE teams SET coach=$2 WHERE id=$1', [id, coachOf(b.coach)]);
    if (logo) await pool.query('UPDATE teams SET logo_data=$2, logo_mime=$3 WHERE id=$1', [id, logo.data, logo.mime]);
    if (b.remove_logo) await pool.query('UPDATE teams SET logo_data=NULL, logo_mime=NULL WHERE id=$1', [id]);
    return id;
  }
  const r = await pool.query(`INSERT INTO teams(name, short_name, primary_color, secondary_color, logo_url, logo_data, logo_mime, grade, grade_order, gender, coach) VALUES ($1,$2,COALESCE($3,'#333333'),COALESCE($4,'#ffffff'),$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [...vals.slice(0, 5), logo?.data ?? null, logo?.mime ?? null, vals[5], gradeOrder(vals[5]), vals[6], coachOf(b.coach)]);
  return r.rows[0].id as number;
}

async function refreshAllCourts() { const { rows } = await pool.query('SELECT slug FROM courts'); for (const r of rows) await broadcastCourt(r.slug); }

/**
 * Shared-floor rule: returns a message naming the first game on a conflicting court (see
 * courts.conflicts_with, symmetric) whose [start, start+length) overlaps the given slot, else null.
 * Same-court and West/East overlaps are not checked here.
 */
/** skipFinals: ignore completed games (restoring finals from CSV: finals never block each other). */
async function floorConflict(courtId: number | null, ts: Date | null, durMin: number | null, excludeId: number | null, skipFinals = false): Promise<string | null> {
  if (!courtId || !ts) return null;
  const { rows } = await pool.query(`
    SELECT g.id, c.name AS court, me.name AS me, h.name AS home, a.name AS away,
      to_char(g.scheduled_at AT TIME ZONE current_setting('TimeZone'), 'YYYY-MM-DD HH24:MI') AS start,
      to_char((g.scheduled_at + make_interval(mins => COALESCE(g.duration_min, $5))) AT TIME ZONE current_setting('TimeZone'), 'HH24:MI') AS end_at
    FROM games g JOIN courts c ON c.id = g.court_id JOIN courts me ON me.id = $1
      JOIN teams h ON h.id = g.home_team_id JOIN teams a ON a.id = g.away_team_id
    WHERE g.id IS DISTINCT FROM $4 AND g.scheduled_at IS NOT NULL AND c.id <> me.id
      AND (c.slug = ANY(me.conflicts_with) OR me.slug = ANY(c.conflicts_with))
      AND g.scheduled_at < $2::timestamptz + make_interval(mins => $3)
      AND $2::timestamptz < g.scheduled_at + make_interval(mins => COALESCE(g.duration_min, $5))
      AND (NOT $6::boolean OR g.status <> 'complete')
    ORDER BY g.scheduled_at, g.id LIMIT 1`, [courtId, ts, durMin ?? GAME_MINUTES, excludeId, GAME_MINUTES, skipFinals]);
  const c = rows[0];
  return c ? `overlaps game #${c.id} on ${c.court} (${c.home} vs ${c.away}, ${c.start}-${c.end_at}); ${c.me} and ${c.court} share the floor and can't be used at the same time` : null;
}
type Qy = { query: (text: string, params?: any[]) => Promise<any> };
/**
 * Reschedule + PUT checks beyond the shared floor: same-court overlap and a team already playing at that time.
 * Returns error messages ([] = ok). Overlap = [start, start + length) intersects (default length GAME_MINUTES).
 */
async function slotConflicts(q: Qy, courtId: number | null, ts: Date | null, durMin: number | null, excludeId: number | null, teamIds: number[], skipFinals = false): Promise<string[]> {
  if (!ts) return [];
  const { rows } = await q.query(`
    SELECT g.id, g.court_id, c.name AS court, h.name AS home, a.name AS away, g.home_team_id, g.away_team_id,
      to_char(g.scheduled_at AT TIME ZONE $6, 'Dy HH24:MI') AS start
    FROM games g LEFT JOIN courts c ON c.id = g.court_id JOIN teams h ON h.id = g.home_team_id JOIN teams a ON a.id = g.away_team_id
    WHERE g.id IS DISTINCT FROM $3 AND g.scheduled_at IS NOT NULL
      AND g.scheduled_at < $1::timestamptz + make_interval(mins => $2)
      AND $1::timestamptz < g.scheduled_at + make_interval(mins => COALESCE(g.duration_min, $5))
      AND ((g.court_id = $4) OR g.home_team_id = ANY($7) OR g.away_team_id = ANY($7))
      AND (NOT $8::boolean OR g.status <> 'complete')
    ORDER BY g.scheduled_at, g.id`, [ts, durMin ?? GAME_MINUTES, excludeId, courtId, GAME_MINUTES, LEAGUE_TZ, teamIds, skipFinals]);
  const out: string[] = [];
  for (const r of rows) {
    if (courtId && r.court_id === courtId) out.push(`${r.court} is already in use: game #${r.id} (${r.home} vs ${r.away}, ${r.start})`);
    for (const t of teamIds) if (r.home_team_id === t || r.away_team_id === t)
      out.push(`${r.home_team_id === t ? r.home : r.away} already plays then: game #${r.id} (${r.home} vs ${r.away}, ${r.start}${r.court ? ' on ' + r.court : ''})`);
  }
  return [...new Set(out)];
}
const parseMinutes = (v: unknown): number | null => {
  const t = String(v ?? '').trim(); if (!t) return null;
  if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 600) throw new HttpError(400, `minutes "${t}" must be a whole number 1-600 (or empty for the default ${GAME_MINUTES})`);
  return Number(t);
};

const parseBool = (v: unknown, col: string): boolean => {
  const t = String(v ?? '').trim().toLowerCase();
  if (['', '0', 'false', 'no', 'n'].includes(t)) return false;
  if (['1', 'true', 'yes', 'y', 'x'].includes(t)) return true;
  throw new HttpError(400, `${col} "${v}" must be true/false (or yes/no, or empty)`);
};
const cheerName = (v: unknown): string | null => {
  const t = String(v ?? '').trim(); if (!t) return null;
  if (t.length > 40) throw new HttpError(400, `cheer squad name "${t.slice(0, 20)}…" is longer than 40 characters`);
  return t;
};
/** Locker room: free text ('CH', '2'), max 8 characters; empty = none. */
const lockerOf = (v: unknown, field = 'locker'): string | null => {
  const t = String(v ?? '').trim(); if (!t) return null;
  if (t.length > 8) throw new HttpError(400, `${field} "${t.slice(0, 12)}" is longer than 8 characters (use a short room name like CH or 2)`);
  return t;
};
/** Coach: first name only, max 30; a typed "Coach " prefix is dropped (pages render "Coach <name>"). */
const coachOf = (v: unknown): string | null => {
  const t = String(v ?? '').trim().replace(/^coach\s+/i, '').trim(); if (!t) return null;
  if (t.length > 30) throw new HttpError(400, `coach "${t.slice(0, 20)}…" is longer than 30 characters (first name only)`);
  return t;
};
const EXTRA_COLS = ['swap_colors', 'home_locker', 'away_locker'];
/** Write the optional per-game fields that are present in `extra` (swap colors, locker rooms). */
async function setGameExtras(id: number, extra: Record<string, any>) {
  const keys = Object.keys(extra).filter((k) => EXTRA_COLS.includes(k));
  if (!keys.length) return;
  await pool.query(`UPDATE games SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1`, [id, ...keys.map((k) => extra[k])]);
}
/** Squad logo: a URL replaces an upload; an upload replaces a URL. */
async function setSquadLogo(sid: number, url: string | null | undefined, upload: { data: Buffer; mime: string } | null, remove = false) {
  if (remove) await pool.query('UPDATE cheer_squads SET logo_url=NULL, logo_data=NULL, logo_mime=NULL WHERE id=$1', [sid]);
  if (url !== undefined) await pool.query(`UPDATE cheer_squads SET logo_url=$2${url ? ', logo_data=NULL, logo_mime=NULL' : ''} WHERE id=$1`, [sid, url]);
  if (upload) await pool.query('UPDATE cheer_squads SET logo_data=$2, logo_mime=$3, logo_url=NULL WHERE id=$1', [sid, upload.data, upload.mime]);
}
/**
 * Admin JSON body -> extras. Lockers per game. Until the phase-2 Admin slot editor ships, the old per-game cheer
 * fields still work: `cheer` sets (or, empty, removes) the squad of the game's TIME SLOT, shared by every court in
 * that hour; cheer logo fields update that squad's logo. The games.cheer* columns themselves are never written.
 */
async function gameExtrasFromBody(id: number, b: any) {
  const extra: Record<string, any> = {};
  if ('swap_colors' in b) extra.swap_colors = !!b.swap_colors;
  if ('home_locker' in b) extra.home_locker = lockerOf(b.home_locker, 'home_locker');
  if ('away_locker' in b) extra.away_locker = lockerOf(b.away_locker, 'away_locker');
  const logo = decodeLogo(b.cheer_logo_data_url);
  const logoUrl = 'cheer_logo_url' in b ? safeLogoUrl(String(b.cheer_logo_url || '').trim() || null) : undefined;
  await setGameExtras(id, extra);
  const hasCheer = 'cheer' in b || 'home_cheer' in b || 'away_cheer' in b;
  if (!hasCheer && !logo && logoUrl === undefined && !b.remove_cheer_logo) return;
  const slot = await gameSlot(pool, id);
  if (!slot) { if (hasCheer && (cheerName(b.cheer) || cheerName(b.home_cheer) || cheerName(b.away_cheer))) throw new HttpError(400, 'set the game time first: cheer squads are assigned per time slot'); return; }
  const name = hasCheer ? ('cheer' in b ? cheerName(b.cheer) : cheerName(b.home_cheer) || cheerName(b.away_cheer)) : undefined;
  if (name === null) { await pool.query('DELETE FROM cheer_slots WHERE date=$1 AND slot_start=$2', [slot.date, slot.start]); return; }
  const sid = name ? await squadId(pool, name) : (await pool.query('SELECT squad_id FROM cheer_slots WHERE date=$1 AND slot_start=$2', [slot.date, slot.start])).rows[0]?.squad_id;
  // logo first, then the slot, so a concurrent snapshot never shows the new squad without its logo
  if (sid && (logo || logoUrl !== undefined || b.remove_cheer_logo)) await setSquadLogo(sid, logo ? undefined : logoUrl, logo, !!b.remove_cheer_logo);
  if (name && sid) await setSlotSquad(pool, slot.date, slot.start, sid);
}

/** Grade rule for a game (import + admin): both teams in the same grade, and matching an optional stated grade. */
async function gradeCheck(homeId: number, awayId: number, stated: string | null, statedGender: string | null = null): Promise<string | null> {
  const { rows } = await pool.query('SELECT id, name, grade, gender FROM teams WHERE id = ANY($1)', [[homeId, awayId]]);
  const h = rows.find((t) => t.id === Number(homeId)), a = rows.find((t) => t.id === Number(awayId));
  if (!h || !a) throw new HttpError(400, 'unknown team');
  return gradeMismatch(h, a, stated) || genderMismatch(h, a, statedGender);
}

/** All schedule warnings (team twice in a weekend, cheer rules, split-court hours), computed in league time. */
async function loadWarnings() {
  const { rows } = await pool.query(`SELECT g.id, to_char(g.scheduled_at AT TIME ZONE $1, 'YYYY-MM-DD') AS date,
      (EXTRACT(HOUR FROM g.scheduled_at AT TIME ZONE $1) * 60 + EXTRACT(MINUTE FROM g.scheduled_at AT TIME ZONE $1))::int AS start_min,
      COALESCE(g.duration_min, $2)::int AS dur, c.slug AS court, COALESCE(h.grade, a.grade) AS grade,
      concat_ws(' ', COALESCE(h.grade, a.grade), COALESCE(h.gender, a.gender)) AS label,
      g.home_team_id, g.away_team_id, h.name AS home, a.name AS away, cq.name AS cheer
    FROM games g JOIN teams h ON h.id=g.home_team_id JOIN teams a ON a.id=g.away_team_id LEFT JOIN courts c ON c.id=g.court_id
    ${CHEER_JOIN}`, [LEAGUE_TZ, GAME_MINUTES]);
  const games = rows.map((r): WarnGame => ({ id: r.id, date: r.date, startMin: r.start_min, durMin: r.dur, court: r.court, grade: r.grade, label: r.label || null,
    homeId: r.home_team_id, awayId: r.away_team_id, home: r.home, away: r.away, hasCheer: !!r.cheer, cheer: r.cheer }));
  const slots = (await pool.query(`SELECT to_char(s.date, 'YYYY-MM-DD') AS date, to_char(s.slot_start, 'HH24:MI') AS start, q.name AS squad
    FROM cheer_slots s JOIN cheer_squads q ON q.id = s.squad_id ORDER BY s.date, s.slot_start`)).rows;
  // Per-game warnings first (by game id), then the slot-level ones (gameId null).
  return [...scheduleWarnings(games), ...cheerSlotWarnings(slots, games, await legacyCheerConflicts())];
}
const warningsFor = async (id: number) => (await loadWarnings()).filter((w) => w.gameId != null && w.gameId === id).map((w) => w.message);

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ampm12 = (hm: string) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const dayLabel = (date: string, hm: string) => `${DOW[new Date(`${date}T12:00:00Z`).getUTCDay()]} ${date.slice(5).replace('-', '/')} ${ampm12(hm)}`;
/**
 * Admin reschedule (docs/plans/reschedule-games.md, approved): new league-local date and/or tip-off time only. Court and
 * lockers never change. Fri/Sat only; scheduled games only; shared floor + same court + team + natural-key checks;
 * cheer comes from the new hour's slot. One transaction with the game row locked; dryRun rolls back (writes nothing).
 * Errors -> 409 { errors[], preview }. time is optional (defaults to the current tip-off).
 */
/** Parse an admin timestamp; a bad one (2026-02-30T10:00) is a 400, not a 500. */
/** League-local date + HH:MM of a timestamp (for gameTimeErrors). */
async function leagueLocal(ts: Date): Promise<{ d: string; t: string }> {
  return (await pool.query(`SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS d, to_char($1::timestamptz AT TIME ZONE $2, 'HH24:MI') AS t`, [ts, LEAGUE_TZ])).rows[0];
}
async function tsOf(v: unknown): Promise<Date> {
  const sv = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(sv);
  if (m && !isIsoDate(m[1])) throw new HttpError(400, `scheduled_at ${sv}: not a real calendar date`);
  try { return (await pool.query('SELECT $1::timestamptz AS t', [sv])).rows[0].t; }
  catch { throw new HttpError(400, `scheduled_at ${sv}: not a valid date/time`); }
}
/** Audit a plain edit of time/court/length (game_changes kind 'edit', or 'reschedule' when the time moved). */
async function logGameEdit(id: number, before: any, after: any, kind: 'edit' | 'reschedule') {
  const loc = async (x: any) => {
    const r = (await pool.query(`SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS date, to_char($1::timestamptz AT TIME ZONE $2, 'HH24:MI') AS time,
      (SELECT name FROM courts WHERE id=$3) AS court`, [x.scheduled_at ?? null, LEAGUE_TZ, x.court_id ?? null])).rows[0];
    return { ...r, duration_min: x.duration_min ?? null };
  };
  await pool.query(`INSERT INTO game_changes(game_id, actor, kind, before, after, reason) VALUES ($1, 'admin', $2, $3, $4, NULL)`,
    [id, kind, JSON.stringify(await loc(before)), JSON.stringify(await loc(after))]);
}
async function rescheduleGame(id: number, b: any) {
  const date = String(b?.date ?? '').trim(), reason = String(b?.reason ?? '').trim().slice(0, 200) || null, dry = !!b?.dryRun;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const g = (await client.query(`SELECT g.*, to_char(g.scheduled_at AT TIME ZONE $2, 'YYYY-MM-DD') AS d, to_char(g.scheduled_at AT TIME ZONE $2, 'HH24:MI') AS t,
      c.name AS court_name FROM games g LEFT JOIN courts c ON c.id = g.court_id WHERE g.id=$1 FOR UPDATE OF g`, [id, LEAGUE_TZ])).rows[0];
    if (!g) throw new HttpError(404, 'game not found');
    if (g.status !== 'scheduled') throw new HttpError(409, g.status === 'active' ? 'This game is live: only scheduled games can be rescheduled (end or reset it first).' : 'This game is final: only scheduled games can be rescheduled.');
    const time = String(b?.time ?? '').trim() || g.t;
    if (!isIsoDate(date)) throw new HttpError(400, 'date must be a real calendar date, YYYY-MM-DD');
    if (!time || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'time must be HH:MM (24h, league time)');
    const hm = time.padStart(5, '0');
    const ts = (await client.query(`SELECT ($1::date + $2::time) AT TIME ZONE $3 AS t`, [date, hm, LEAGUE_TZ])).rows[0].t as Date;
    const cheerAt = async (d: string | null, t: string | null) => (d && t ? (await client.query(`SELECT q.name FROM cheer_slots s JOIN cheer_squads q ON q.id = s.squad_id WHERE s.date=$1::date AND s.slot_start=$2::time`, [d, hourSlot(t)])).rows[0]?.name ?? null : null);
    const preview = { from: g.d ? { date: g.d, time: g.t, label: dayLabel(g.d, g.t), cheer: await cheerAt(g.d, g.t) } : null,
      to: { date, time: hm, label: dayLabel(date, hm), cheer: await cheerAt(date, hm) }, court: g.court_name, home_locker: g.home_locker, away_locker: g.away_locker };
    const errors: string[] = [];
    errors.push(...gameTimeErrors(date, hm)); // Fri/Sat + tip-off window (GAME_TIP_WINDOW)
    if (g.scheduled_at && new Date(g.scheduled_at).getTime() === ts.getTime()) errors.push('The game is already at that date and time.');
    const floor = await floorConflict(g.court_id, ts, g.duration_min, id);
    if (floor) errors.push(floor);
    errors.push(...await slotConflicts(client, g.court_id, ts, g.duration_min, id, [g.home_team_id, g.away_team_id]));
    const dup = (await client.query(`SELECT id FROM games WHERE id<>$1 AND court_id IS NOT DISTINCT FROM $2 AND scheduled_at=$3 AND home_team_id=$4 AND away_team_id=$5`, [id, g.court_id, ts, g.home_team_id, g.away_team_id])).rows[0];
    if (dup) errors.push(`That game (same court, time and teams) is already scheduled as game #${dup.id}.`);
    if (errors.length) { await client.query('ROLLBACK'); throw Object.assign(new HttpError(409, errors[0]), { extra: { errors, preview } }); }
    if (dry) { await client.query('ROLLBACK'); return { ok: true, dryRun: true, errors: [], preview }; }
    await client.query(`UPDATE games SET scheduled_at=$2, moved_from=COALESCE(moved_from, scheduled_at), updated_at=now() WHERE id=$1`, [id, ts]);
    const snap = (d: any, t: any) => ({ date: d, time: t, court: g.court_name, home_locker: g.home_locker, away_locker: g.away_locker });
    await client.query(`INSERT INTO game_changes(game_id, actor, kind, before, after, reason) VALUES ($1, 'admin', 'reschedule', $2, $3, $4)`,
      [id, JSON.stringify(snap(g.d, g.t)), JSON.stringify(snap(date, hm)), reason]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
  await refreshAllCourts(); scheduleChanged();
  const row = (await pool.query(`SELECT id, scheduled_at, moved_from, court_id, home_locker, away_locker FROM games WHERE id=$1`, [id])).rows[0];
  return { ok: true, game: row };
}

/**
 * Lobby TV feed for one league-local day (role=schedule WebSocket + /api/public/schedule): every game with court,
 * time, state, teams (home first; locker + coach), live score/period/clock for active games, and the day's cheer slots.
 */
async function scheduleSnapshot(date: string) {
  const { rows } = await pool.query(`${GAME_SELECT}
    WHERE (g.scheduled_at AT TIME ZONE $1)::date = $2::date ORDER BY g.scheduled_at, c.id, g.id`, [LEAGUE_TZ, date]);
  const games = [];
  for (const raw of rows) {
    const r = normalizeRow(raw), theme = r.theme || {};
    const live = r.status === 'active' ? await gameViewNorm(r.id) : null;
    const t = await pool.query(`SELECT to_char($1::timestamptz AT TIME ZONE $2, 'HH24:MI') AS hm, to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS cd, to_char($3::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS md,
      to_char($3::timestamptz AT TIME ZONE $2, 'HH24:MI') AS mt`, [r.scheduled_at, LEAGUE_TZ, r.moved_from ?? null]);
    // Rescheduled: "Moved from Sat 11:00 AM" on the lobby until the game is final (never on court TVs/overlay/scorekeeper).
    const mv = t.rows[0].md && r.status !== 'complete' && +new Date(r.moved_from) !== +new Date(r.scheduled_at)
      ? { movedFrom: { date: t.rows[0].md, day: DOW[new Date(`${t.rows[0].md}T12:00:00Z`).getUTCDay()], time: t.rows[0].mt, sameDay: t.rows[0].md === t.rows[0].cd } } : {};
    const s = live?.state;
    games.push({
      id: r.id, court: r.court_slug, time: t.rows[0].hm, dur: r.duration_min ?? GAME_MINUTES, status: r.status,
      hideScore: isScoreHiddenGrade(r.home_grade || r.away_grade), ...mv,
      home: { ...teamView(r, 'home_team', theme, 'home'), score: s ? s.home.score : r.final_home },
      away: { ...teamView(r, 'away_team', theme, 'away'), score: s ? s.away.score : r.final_away },
      ...(s ? { period: s.period, periods: s.rules.periods, clock: s.clock } : {}),
    });
  }
  // The day's cheer slots (one squad per hour, all courts); the lobby shows one cheer row spanning the courts.
  const cheerSlots = (await pool.query(`SELECT s.id, to_char(s.slot_start, 'HH24:MI') AS start, s.locker, q.id AS squad_id, q.name, q.coach, q.logo_url, (q.logo_data IS NOT NULL) AS has_logo
    FROM cheer_slots s JOIN cheer_squads q ON q.id = s.squad_id WHERE s.date = $1::date ORDER BY s.slot_start`, [date])).rows
    .map((x) => ({ id: x.id, start: x.start, squadId: x.squad_id, name: x.name, coach: x.coach || null, locker: x.locker || null, logo: x.has_logo ? `/logos/squad/${x.squad_id}` : x.logo_url || null }));
  return { type: 'state', kind: 'schedule', serverNow: Date.now(), date, cheerSlots, church: { name: CHURCH_NAME, logo: CHURCH_LOGO_URL }, games };
}

/**
 * Make a game the court's active game (scorekeeper "Load", admin "Start on court", admin reopen).
 * Rules: one active game per court (DB partial unique index), complete the current game first,
 * and the shared floor (Full vs West/East can't both be active; admins may force).
 */
async function activateGame(gameId: number, courtSlug: string | null, actor: string, force: boolean, reopen = false): Promise<number> {
  const g = (await pool.query(`SELECT g.id, g.court_id, g.status, c.slug, c.name AS court FROM games g LEFT JOIN courts c ON c.id=g.court_id WHERE g.id=$1`, [gameId])).rows[0];
  if (!g) throw new HttpError(404, 'game not found');
  if (!g.court_id) throw new HttpError(400, 'assign the game to a court first');
  if (courtSlug && g.slug !== courtSlug) throw new HttpError(400, `That game is on ${g.court}, not this court.`);
  if (g.status === 'complete' && !reopen) throw new HttpError(409, 'That game is complete. An admin can reopen it.');
  if (g.status !== 'active') {
    const live = (await pool.query(`SELECT c.name AS court, me.name AS me, h.name AS home, a.name AS away
      FROM courts c JOIN courts me ON me.id = $1 JOIN games x ON x.court_id = c.id AND x.status = 'active'
      JOIN teams h ON h.id = x.home_team_id JOIN teams a ON a.id = x.away_team_id
      WHERE c.id <> me.id AND (c.slug = ANY(me.conflicts_with) OR me.slug = ANY(c.conflicts_with)) ORDER BY c.id`, [g.court_id])).rows;
    if (live.length && !force) {
      throw new HttpError(409, `${live.map((l) => `${l.court} is live (${l.home} vs ${l.away})`).join(' and ')}. ${live[0].me} shares the floor with ${live.map((l) => l.court).join(' and ')}: complete ${live.length > 1 ? 'those games' : 'that game'} first.`);
    }
    const cur = (await pool.query(`SELECT COALESCE(h.grade || ' ', '') || h.name || ' vs ' || a.name AS m FROM games x JOIN teams h ON h.id=x.home_team_id JOIN teams a ON a.id=x.away_team_id
      WHERE x.court_id=$1 AND x.status='active' AND x.id<>$2`, [g.court_id, gameId])).rows[0];
    if (cur) throw new HttpError(409, `${cur.m} is still active on ${g.court}. Complete it before loading another game.`);
  }
  try {
    if (reopen) await mutate(gameId, actor, null, (h) => dispatch(h, { type: 'REOPEN' }, Date.now()), { type: 'REOPEN' });
    else await mutate(gameId, actor, null, (h) => dispatch(h, { type: 'START_GAME' }, Date.now()), { type: 'START_GAME' });
  } catch (e: any) {
    if (/games_one_active_per_court|duplicate key/.test(e.message)) throw new HttpError(409, `Another game just became active on ${g.court}. Complete it first.`);
    throw e;
  }
  await pool.query('UPDATE courts SET current_game_id=$2 WHERE id=$1', [g.court_id, gameId]);
  await broadcastCourt(g.slug);
  return gameId;
}

/** Public base URL for QR links: PUBLIC_BASE_URL, else the request's host. */
function baseUrl(req: http.IncomingMessage) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0] : 'http';
  return `${proto}://${req.headers.host || 'localhost:3000'}`;
}
async function courtQr(c: any, req: http.IncomingMessage) {
  const exp = weekEnd(Date.now(), process.env.TZ || 'America/Chicago');
  const token = makeQrToken(SESSION_SECRET, c.slug, exp, c.qr_version);
  const url = `${baseUrl(req)}/score/${encodeURIComponent(c.slug)}?t=${encodeURIComponent(token)}`;
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  return { court_id: c.id, slug: c.slug, name: c.name, version: c.qr_version, expires: new Date(exp).toISOString(), url, svg };
}

type ImportResult = { created: number; updated: number; skipped: number; errors: string[]; warnings?: string[] };
function requireColumns(headers: string[], need: string[], file: string) {
  if (!headers.length) throw new HttpError(400, `${file} is empty`);
  const missing = need.filter((c) => !headers.includes(c));
  if (missing.length) throw new HttpError(400, `${file} is missing required column(s): ${missing.join(', ')}. Expected header: ${need.join(',')}`);
}

async function importTeams(text: string): Promise<ImportResult> {
  const { headers, rows } = parseCsvTable(text);
  requireColumns(headers, ['name'], 'teams.csv');
  const out: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }; const seen = new Map<string, number>();
  for (const [i, r] of rows.entries()) {
    const line = i + 2;
    try {
      const v = teamValues(r, false); const hasGrade = headers.includes('grade'), hasGender = headers.includes('gender');
      const key = `${hasGrade ? v[5] ?? '' : '*'}|${hasGender ? v[6] ?? '' : '*'}|${v[0].toLowerCase()}`;
      if (seen.has(key)) { out.skipped++; out.errors.push(`row ${line}: duplicate of row ${seen.get(key)} (skipped)`); continue; }
      seen.set(key, line);
      // Match on grade + name. Old files without a grade column match by name (must be unambiguous).
      // A team that has no grade yet is adopted by a row naming it with a grade (instead of creating a twin).
      let sameName = (await pool.query('SELECT id, name, short_name, primary_color, secondary_color, logo_url, grade, gender, coach FROM teams WHERE lower(name)=lower($1)', [v[0]])).rows;
      // With a gender column: match grade + gender + name; a team without a gender yet is adopted (no twin).
      if (hasGender) { const exact = sameName.filter((t) => t.gender === v[6]); sameName = exact.length ? exact : sameName.filter((t) => t.gender == null); }
      else delete (r as any).gender;
      let ex;
      if (hasGrade) ex = sameName.find((t) => (t.grade ?? null) === v[5]) ?? (v[5] ? sameName.find((t) => t.grade == null && sameName.length === 1) : undefined);
      else {
        if (sameName.length > 1) throw new HttpError(400, `"${v[0]}" exists in ${sameName.map((t) => t.grade || 'no grade').join(' and ')}; add a grade column`);
        ex = sameName[0]; delete (r as any).grade; // keep the team's grade
      }
      if (!ex) { await upsertTeam(r, undefined, false); out.created++; continue; }
      const same = ex.name === v[0] && ex.short_name === v[1] && (ex.logo_url ?? null) === v[4] && (!headers.includes('grade') || (ex.grade ?? null) === v[5]) && (!hasGender || (ex.gender ?? null) === v[6])
        && (!headers.includes('coach') || (ex.coach ?? null) === coachOf(r.coach)); // color columns are ignored (season colors); absent coach column = keep
      if (same) { out.skipped++; continue; }
      await upsertTeam(r, ex.id, false); out.updated++;
    } catch (e: any) { out.errors.push(`row ${line}: ${e.message}`); }
  }
  return out;
}

async function importCourts(text: string): Promise<ImportResult> {
  const { headers, rows } = parseCsvTable(text);
  requireColumns(headers, ['slug', 'name'], 'courts.csv');
  const out: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }; const seen = new Map<string, number>();
  for (const [i, r] of rows.entries()) {
    const line = i + 2;
    try {
      const name = (r.name || '').trim(), slug = (r.slug || '').trim().toLowerCase(), location = (r.location || '').trim() || null;
      if (!name) throw new HttpError(400, 'name required');
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new HttpError(400, `slug "${r.slug}" must be lowercase letters, digits and dashes (e.g. west)`);
      if (seen.has(slug)) { out.skipped++; out.errors.push(`row ${line}: duplicate of row ${seen.get(slug)} (skipped)`); continue; }
      seen.set(slug, line);
      const ex = (await pool.query('SELECT id, name, location, conflicts_with FROM courts WHERE slug=$1', [slug])).rows[0];
      // conflicts_with is optional: "west east" = can't overlap those courts. Column absent = leave as is.
      const conf = headers.includes('conflicts_with') ? parseConflicts(r.conflicts_with).filter((s) => s !== slug) : (ex?.conflicts_with ?? []);
      if (!ex) { await pool.query('INSERT INTO courts(slug, name, location, conflicts_with) VALUES ($1,$2,$3,$4)', [slug, name, location, conf]); out.created++; }
      else if (ex.name === name && (ex.location ?? null) === location && [...ex.conflicts_with].sort().join(' ') === conf.join(' ')) out.skipped++;
      else { await pool.query('UPDATE courts SET name=$2, location=$3, conflicts_with=$4 WHERE id=$1', [ex.id, name, location, conf]); out.updated++; }
    } catch (e: any) { out.errors.push(`row ${line}: ${e.message}`); }
  }
  return out;
}

/** Idempotent schedule import: match by exported id, else by court+start+home+away (unique index). */
async function importSchedule(text: string): Promise<ImportResult> {
  const { headers, rows } = parseCsvTable(text);
  const FULL = ['date', 'time', 'court', 'home', 'away'];
  // With an id column, rows can be partial (e.g. id + status); rows without an id still need the full set.
  requireColumns(headers, headers.includes('id') ? ['id'] : FULL, 'schedule.csv');
  const out: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [], warnings: [] }; const seen = new Map<string, number>();
  const touched = new Set<number>();
  const legacyCheerSlots = new Map<string, { name: string; logo: string | null; line: number }>();
  const team = async (n: string, col: string) => {
    if (!n) throw new HttpError(400, `${col} team is empty`);
    return n.trim();
  };
  /** Resolve home + away by grade + name: stated grade, else unambiguous name, else the other team's grade. */
  const resolvePair = async (hn: string, an: string, stated: string | null, sg: string | null = null) => {
    let h = await findTeam(hn, stated, sg), a = await findTeam(an, stated, sg);
    if (h && 'error' in h && a && !('error' in a)) h = await findTeam(hn, a.grade, a.gender);
    if (a && 'error' in a && h && !('error' in h)) a = await findTeam(an, h.grade, h.gender);
    for (const [t, n, col] of [[h, hn, 'home'], [a, an, 'away']] as const) {
      if (!t) throw new HttpError(400, `unknown ${col} team "${n}"${stated ? ' in ' + stated : ''} (import teams.csv first)`);
      if ('error' in t) throw new HttpError(400, `${col} team ${t.error}`);
    }
    return [(h as any).id as number, (a as any).id as number];
  };
  /** Optional status column (scheduled / active / complete; old exports say live / final). */
  const applyStatus = async (ex: any, r: Record<string, string>): Promise<'updated' | 'same'> => {
    if (!headers.includes('status') || !(r.status || '').trim()) return 'same';
    const st = ({ live: 'active', final: 'complete' } as any)[(r.status || '').trim().toLowerCase()] || (r.status || '').trim().toLowerCase();
    if (!['scheduled', 'active', 'complete'].includes(st)) throw new HttpError(400, `status "${r.status}" must be scheduled, active or complete`);
    if (st === ex.status) return 'same';
    // Results played elsewhere can be recorded for a game that never started; started games change status in Admin.
    if (ex.history || st === 'active') throw new HttpError(400, `status ${ex.status} -> ${st}: change a started game's status in Admin (Complete / Reopen); games become active from the scorekeeper or Admin`);
    const hs = (r.home_score || '').trim(), as = (r.away_score || '').trim();
    if (st === 'complete' && !(/^\d+$/.test(hs) && /^\d+$/.test(as))) throw new HttpError(400, 'status complete needs home_score and away_score');
    await pool.query('UPDATE games SET status=$2, final_home=$3, final_away=$4 WHERE id=$1', [ex.id, st, st === 'complete' ? Number(hs) : null, st === 'complete' ? Number(as) : null]);
    runtimes.delete(ex.id); return 'updated';
  };
  for (const [i, r] of rows.entries()) {
    const line = i + 2;
    try {
      const rid = (r.id || '').trim();
      // Partial row (id + status, everything else blank or absent): update only the status.
      if (rid && FULL.every((c) => !(r[c] || '').trim())) {
        if (!/^\d+$/.test(rid)) throw new HttpError(400, `id "${rid}" must be a number from an export (or leave it blank)`);
        if (seen.has('id:' + rid)) { out.skipped++; out.errors.push(`row ${line}: duplicate of row ${seen.get('id:' + rid)} (skipped)`); continue; }
        seen.set('id:' + rid, line);
        const ex = (await pool.query('SELECT * FROM games WHERE id=$1', [Number(rid)])).rows[0];
        if (!ex) throw new HttpError(400, `unknown game id ${rid}`);
        if ((await applyStatus(ex, r)) === 'updated') out.updated++; else out.skipped++;
        continue;
      }
      const missing = FULL.filter((c) => !headers.includes(c));
      if (missing.length) throw new HttpError(400, `a row without an id needs the columns ${missing.join(', ')}`);
      const date = (r.date || '').trim(), time = (r.time || '').trim();
      if (date || time) { // both empty = "not scheduled yet" (allowed; exports write it that way)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, `date "${r.date}" must be YYYY-MM-DD (or leave date and time both empty)`);
        if (!/^\d{1,2}:\d{2}$/.test(time)) throw new HttpError(400, `time "${r.time}" must be HH:MM (24h, league time)`);
        if (!isIsoDate(date)) throw new HttpError(400, `date "${r.date}" is not a real calendar date`);
      }
      // Fri/Sat + tip-off window, same validator as create / reschedule. Checked below for new games and changed times
      // (an exported row whose time is unchanged still round-trips).
      const timeErrs = date ? gameTimeErrors(date, time.padStart(5, '0')) : [];
      const slug = (r.court || '').trim();
      const court = slug ? (await pool.query('SELECT id FROM courts WHERE slug=lower($1)', [slug])).rows[0] : { id: null };
      if (!court) throw new HttpError(400, `unknown court "${r.court}" (use a slug from courts.csv, e.g. west)`);
      const stated = headers.includes('grade') ? gradeOf(r.grade) : null;
      const statedGender = headers.includes('gender') ? genderOf(r.gender) : null;
      const [home, away] = await resolvePair(await team(r.home, 'home'), await team(r.away, 'away'), stated, statedGender);
      if (home === away) throw new HttpError(400, 'home and away are the same team');
      const gm = await gradeCheck(home, away, stated, statedGender);
      if (gm) throw new HttpError(400, gm);
      const when = date ? `${date} ${time}` : null; const division = (r.division || '').trim() || null;
      const hasMin = headers.includes('minutes'); const minutes = hasMin ? parseMinutes(r.minutes) : null;
      // Optional columns (old CSVs without them still import; absent column = keep the game's current value).
      const extra: Record<string, any> = {};
      if (headers.includes('swap_colors')) extra.swap_colors = parseBool(r.swap_colors, 'swap_colors');
      // Locker rooms (per game, change weekly): absent column = keep, blank cell = clear.
      if (headers.includes('home_locker')) extra.home_locker = lockerOf(r.home_locker, 'home_locker');
      if (headers.includes('away_locker')) extra.away_locker = lockerOf(r.away_locker, 'away_locker');
      // Legacy cheer columns (cheer + cheer_logo; older home_cheer/away_cheer): mapped to the row's TIME SLOT after the
      // loop. A blank cell does not clear a slot (another court's row may name it); clear slots in cheer_slots.csv.
      let legacyCheer: string | null = null, legacyLogo: string | null = null;
      if (headers.includes('cheer')) legacyCheer = cheerName(r.cheer);
      else if (headers.includes('home_cheer') || headers.includes('away_cheer')) {
        const hc = cheerName(r.home_cheer), ac = cheerName(r.away_cheer);
        if (hc && ac && hc.toLowerCase() !== ac.toLowerCase()) out.warnings!.push(`row ${line}: two cheer squads (home_cheer "${hc}", away_cheer "${ac}"); one squad per time slot, kept "${hc}"`);
        legacyCheer = hc || ac;
      }
      const logoCol = headers.includes('cheer_logo') ? 'cheer_logo' : (r.home_cheer || '').trim() ? 'home_cheer_logo' : 'away_cheer_logo';
      if (legacyCheer && headers.includes(logoCol)) {
        const v = (r[logoCol] || '').trim();
        // An exported upload address (/logos/cheer/<game> or /logos/squad/<id>) means "keep the squad's logo".
        legacyLogo = v && !/\/logos\/(cheer|squad)\/\d+(?:\/(?:home|away))?$/.test(v) ? safeLogoUrl(v) : null;
      }
      if (legacyCheer && date) {
        const k = `${date}|${hourSlot(time)}`, prev = legacyCheerSlots.get(k);
        if (prev && prev.name.toLowerCase() !== legacyCheer.toLowerCase()) out.warnings!.push(`row ${line}: cheer "${legacyCheer}" conflicts with "${prev.name}" (row ${prev.line}) for the ${date} ${hourSlot(time)} slot; one squad per time slot, kept "${prev.name}"`);
        else if (!prev) legacyCheerSlots.set(k, { name: legacyCheer, logo: legacyLogo, line });
      } else if (legacyCheer) out.warnings!.push(`row ${line}: cheer "${legacyCheer}" ignored: the game has no date/time (cheer squads are per time slot)`);
      const id = (r.id || '').trim();
      let ts = (await pool.query('SELECT $1::timestamp::timestamptz AS t', [when])).rows[0].t as Date | null;
      const key = `${court.id}|${ts?.getTime() ?? ''}|${home}|${away}`;
      if (seen.has(key) || (id && seen.has('id:' + id))) { out.skipped++; out.errors.push(`row ${line}: duplicate of row ${seen.get(key) ?? seen.get('id:' + id)} (skipped)`); continue; }
      seen.set(key, line); if (id) seen.set('id:' + id, line);
      let ex;
      if (id) {
        if (!/^\d+$/.test(id)) throw new HttpError(400, `id "${id}" must be a number from an export (or leave it blank)`);
        ex = (await pool.query('SELECT * FROM games WHERE id=$1', [Number(id)])).rows[0];
        if (!ex) throw new HttpError(400, `unknown game id ${id} (leave id blank to add a new game)`);
      } else {
        ex = (await pool.query('SELECT * FROM games WHERE court_id IS NOT DISTINCT FROM $1 AND scheduled_at IS NOT DISTINCT FROM $2 AND home_team_id=$3 AND away_team_id=$4', [court.id, ts, home, away])).rows[0];
      }
      // Rescheduled games (moved_from_date/_time are read-only export columns, ignored here): an old row at the ORIGINAL
      // time must not undo the move (row with id) or add a duplicate game (row without id). Keep the move and warn.
      const movedMsg = (g: any) => `row ${line}: game #${g.id} was rescheduled (originally ${date} ${time}); kept the new time (edit the game in Admin to change it)`;
      if (ex && ex.moved_from && ts && +new Date(ex.moved_from) === +ts && +new Date(ex.scheduled_at) !== +ts) { out.warnings!.push(movedMsg(ex)); ts = ex.scheduled_at; }
      if (!ex && !id && ts) {
        const mv = (await pool.query('SELECT id FROM games WHERE court_id IS NOT DISTINCT FROM $1 AND moved_from=$2 AND home_team_id=$3 AND away_team_id=$4', [court.id, ts, home, away])).rows[0];
        if (mv) { out.warnings!.push(movedMsg(mv)); out.skipped++; continue; }
      }
      const dur = hasMin ? minutes : (ex?.duration_min ?? null);
      const timeChanged = !!ts && (!ex || +new Date(ex.scheduled_at ?? 0) !== +ts);
      // Final games (row status complete/final, or the game is already final) are exempt from the game-hours rule:
      // restoring a season's results must not be rejected (Aaron 2026-10-23). Warning only.
      const rowSt = (r.status || '').trim().toLowerCase(); const isFinal = ['complete', 'final'].includes(rowSt) || ex?.status === 'complete';
      if (timeChanged && timeErrs.length) {
        if (isFinal) out.warnings!.push(`row ${line}: ${date} ${time}: ${timeErrs.join(' ')} (final game, imported anyway)`);
        else throw new HttpError(400, `${date} ${time}: ${timeErrs.join(' ')} (row not imported)`);
      }
      /** Same checks as create / reschedule / edit (shared floor, same court, team double-booked); finals don't block finals. */
      const conflicts = async (excl: number | null) => {
        const errs: string[] = []; const fc = await floorConflict(court.id, ts, dur, excl, isFinal); if (fc) errs.push(fc);
        errs.push(...await slotConflicts(pool, court.id, ts, dur, excl, [home, away], isFinal));
        if (errs.length) throw new HttpError(409, `${date} ${time}: ${errs.join('; ')} (row not imported)`);
      };
      if (!ex) {
        await conflicts(null);
        // Restoring a final (new row with status complete/final): needs both scores, then stored as complete.
        if (isFinal && !(/^\d+$/.test((r.home_score || '').trim()) && /^\d+$/.test((r.away_score || '').trim()))) throw new HttpError(400, 'status complete needs home_score and away_score');
        const nid = (await pool.query('INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, division, duration_min) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [court.id, home, away, ts, division, dur])).rows[0].id;
        await setGameExtras(nid, extra); touched.add(nid);
        if (isFinal) await applyStatus({ id: nid, status: 'scheduled', history: null }, r);
        out.created++; continue;
      }
      touched.add(ex.id);
      const st = await applyStatus(ex, r);
      if (st === 'updated') { out.updated++; continue; }
      const extrasSame = Object.entries(extra).every(([k, v]) => (ex[k] ?? null) === v);
      const same = ex.court_id === court.id && (ex.scheduled_at ? new Date(ex.scheduled_at).getTime() : null) === (ts ? ts.getTime() : null) && ex.home_team_id === home && ex.away_team_id === away && (ex.division ?? null) === division && (ex.duration_min ?? null) === dur && extrasSame;
      if (same) { out.skipped++; continue; }
      await conflicts(ex.id);
      await pool.query('UPDATE games SET court_id=$2, scheduled_at=$3, home_team_id=$4, away_team_id=$5, division=$6, duration_min=$7 WHERE id=$1', [ex.id, court.id, ts, home, away, division, dur]);
      await setGameExtras(ex.id, extra);
      out.updated++;
    } catch (e: any) {
      out.errors.push(`row ${line}: ${/duplicate key/.test(e.message) ? 'another game already has this court, time and teams' : e.message}`);
    }
  }
  // Legacy cheer columns -> cheer slots (squad created when new; an existing slot keeps its locker).
  let mapped = 0;
  for (const [k, c] of legacyCheerSlots) {
    const [date, start] = k.split('|');
    const sid = await squadId(pool, c.name);
    if (c.logo) { const q = (await pool.query('SELECT logo_url, logo_data IS NOT NULL AS up FROM cheer_squads WHERE id=$1', [sid])).rows[0]; if (q.logo_url !== c.logo && !q.up) await setSquadLogo(sid, c.logo, null); }
    if (await setSlotSquad(pool, date, start, sid)) mapped++;
  }
  if (mapped) out.warnings!.push(`legacy cheer column: ${mapped} cheer slot(s) set from this file (cheer is now one squad per time slot; use cheer_slots.csv)`);
  if (mapped) scheduleChanged();
  // Warnings (not errors) for the games in this file, checked against the whole schedule (e.g. a team twice in a weekend).
  out.warnings = [...new Set([...out.warnings!, ...(await loadWarnings()).filter((w) => w.gameId != null && touched.has(w.gameId)).map((w) => w.message)])];
  return out;
}

/** cheer_squads.csv: name (key, case-insensitive), coach, optional logo. Absent column = keep, blank cell = clear. */
async function importCheerSquads(text: string): Promise<ImportResult> {
  const { headers, rows } = parseCsvTable(text);
  requireColumns(headers, ['name'], 'cheer_squads.csv');
  const out: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [], warnings: [] }; const seen = new Map<string, number>();
  for (const [i, r] of rows.entries()) {
    const line = i + 2;
    try {
      const name = cheerName(r.name); if (!name) throw new HttpError(400, 'name required');
      const key = name.toLowerCase();
      if (seen.has(key)) { out.skipped++; out.errors.push(`row ${line}: duplicate of row ${seen.get(key)} (skipped)`); continue; }
      seen.set(key, line);
      const ex = (await pool.query('SELECT id, name, coach, logo_url, (logo_data IS NOT NULL) AS up FROM cheer_squads WHERE lower(name)=lower($1)', [name])).rows[0];
      const coach = headers.includes('coach') ? coachOf(r.coach) : undefined;
      // logo: a URL; this squad's own exported upload address keeps the upload; blank clears.
      let logo: string | null | undefined = undefined, keepUpload = false;
      if (headers.includes('logo')) {
        const v = (r.logo || '').trim(), mm = /\/logos\/squad\/(\d+)$/.exec(v);
        if (mm) { if (ex && Number(mm[1]) === ex.id && ex.up) keepUpload = true; else { logo = null; out.warnings!.push(`row ${line}: logo points to another squad's upload; not copied (upload it in Admin)`); } }
        else logo = v ? safeLogoUrl(v) : null;
      }
      if (!ex) {
        const sid = (await pool.query('INSERT INTO cheer_squads(name, coach, logo_url) VALUES ($1,$2,$3) RETURNING id', [name, coach ?? null, logo ?? null])).rows[0].id;
        void sid; out.created++; continue;
      }
      const same = ex.name === name && (coach === undefined || (ex.coach ?? null) === coach)
        && (keepUpload || logo === undefined || ((ex.logo_url ?? null) === logo && !(logo === null && ex.up)));
      if (same) { out.skipped++; continue; }
      await pool.query('UPDATE cheer_squads SET name=$2 WHERE id=$1', [ex.id, name]);
      if (coach !== undefined) await pool.query('UPDATE cheer_squads SET coach=$2 WHERE id=$1', [ex.id, coach]);
      if (!keepUpload && logo !== undefined) await setSquadLogo(ex.id, logo, null, logo === null);
      out.updated++;
    } catch (e: any) { out.errors.push(`row ${line}: ${e.message}`); }
  }
  return out;
}

/**
 * cheer_slots.csv: date, time, squad, locker. Key = date + time floored to the hour (09:05 -> the 09:00 slot).
 * Blank squad = no cheer in that slot (deletes it). Unknown squad = error (import cheer_squads.csv first).
 * locker: absent column = keep, blank = clear.
 */
async function importCheerSlots(text: string): Promise<ImportResult> {
  const { headers, rows } = parseCsvTable(text);
  requireColumns(headers, ['date', 'time', 'squad'], 'cheer_slots.csv');
  const out: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [], warnings: [] }; const seen = new Map<string, number>();
  for (const [i, r] of rows.entries()) {
    const line = i + 2;
    try {
      const date = (r.date || '').trim(), time = (r.time || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) throw new HttpError(400, `date "${r.date}" must be YYYY-MM-DD`);
      let start: string; try { start = hourSlot(time); } catch (e: any) { throw new HttpError(400, e.message); }
      if (!/:00$/.test(time)) out.warnings!.push(`row ${line}: time ${time} is in the ${start} slot (slots are whole hours)`);
      const key = `${date}|${start}`;
      if (seen.has(key)) { out.skipped++; out.errors.push(`row ${line}: duplicate of row ${seen.get(key)} (same ${start} slot, skipped)`); continue; }
      seen.set(key, line);
      const ex = (await pool.query('SELECT id, squad_id, locker FROM cheer_slots WHERE date=$1 AND slot_start=$2', [date, start])).rows[0];
      const squad = cheerName(r.squad);
      if (!squad) {
        if (ex) { await pool.query('DELETE FROM cheer_slots WHERE id=$1', [ex.id]); out.updated++; } else out.skipped++;
        continue;
      }
      const q = (await pool.query('SELECT id FROM cheer_squads WHERE lower(name)=lower($1)', [squad])).rows[0];
      if (!q) throw new HttpError(400, `unknown cheer squad "${squad}" (import cheer_squads.csv first)`);
      const locker = headers.includes('locker') ? lockerOf(r.locker) : undefined;
      if (!ex) { await pool.query('INSERT INTO cheer_slots(date, slot_start, squad_id, locker) VALUES ($1,$2,$3,$4)', [date, start, q.id, locker ?? null]); out.created++; continue; }
      if (ex.squad_id === q.id && (locker === undefined || (ex.locker ?? null) === locker)) { out.skipped++; continue; }
      await pool.query('UPDATE cheer_slots SET squad_id=$2, locker=CASE WHEN $4 THEN $3 ELSE locker END WHERE id=$1', [ex.id, q.id, locker ?? null, locker !== undefined]);
      out.updated++;
    } catch (e: any) { out.errors.push(`row ${line}: ${e.message}`); }
  }
  return out;
}

/** Admin cheer squad body -> validated values (name, coach, logo URL/upload). */
async function upsertSquad(b: any, id?: number): Promise<number> {
  const name = cheerName(b.name); if (!name) throw new HttpError(400, 'name required');
  const coach = 'coach' in b ? coachOf(b.coach) : undefined;
  const url = 'logo_url' in b ? safeLogoUrl(String(b.logo_url || '').trim() || null) : undefined;
  const logo = decodeLogo(b.logo_data_url);
  try {
    if (!id) id = (await pool.query('INSERT INTO cheer_squads(name, coach) VALUES ($1,$2) RETURNING id', [name, coach ?? null])).rows[0].id as number;
    else {
      const r = await pool.query('UPDATE cheer_squads SET name=$2 WHERE id=$1', [id, name]);
      if (!r.rowCount) throw new HttpError(404, 'cheer squad not found');
      if (coach !== undefined) await pool.query('UPDATE cheer_squads SET coach=$2 WHERE id=$1', [id, coach]);
    }
  } catch (e: any) { if (/cheer_squads_name_uk/.test(e.message)) throw new HttpError(409, `A cheer squad named "${name}" already exists.`); throw e; }
  await setSquadLogo(id, logo ? undefined : url, logo, !!b.remove_logo);
  return id;
}
/** Admin cheer slot body: date, time (any HH:MM in the hour), squad_id (or squad name), locker. */
async function slotValues(b: any) {
  const date = String(b.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  let start: string; try { start = hourSlot(String(b.time ?? b.slot_start ?? '')); } catch (e: any) { throw new HttpError(400, e.message); }
  let sid = b.squad_id ? Number(b.squad_id) : null;
  if (!sid && b.squad) sid = (await pool.query('SELECT id FROM cheer_squads WHERE lower(name)=lower($1)', [String(b.squad).trim()])).rows[0]?.id ?? null;
  if (!sid || !(await pool.query('SELECT 1 FROM cheer_squads WHERE id=$1', [sid])).rowCount) throw new HttpError(400, 'pick an existing cheer squad (squad_id)');
  return { date, start, sid, locker: 'locker' in b ? lockerOf(b.locker) : undefined };
}
const SLOT_SELECT = `SELECT s.id, to_char(s.date, 'YYYY-MM-DD') AS date, to_char(s.slot_start, 'HH24:MI') AS time, s.squad_id, q.name AS squad, q.coach, s.locker
  FROM cheer_slots s JOIN cheer_squads q ON q.id = s.squad_id`;

async function api(req: http.IncomingMessage, res: http.ServerResponse, u: URL): Promise<void> {
  const p = u.pathname, m = req.method || 'GET';
  const seg = p.split('/').filter(Boolean); // ['api', ...]
  if (p === '/api/health') { await pool.query('SELECT 1'); return json(res, 200, { ok: true, serverNow: Date.now() }); }
  if (p === '/api/login' && m === 'POST') {
    const key = `login:${clientIp(req)}`;
    const wait = loginLimiter.retryAfter(key);
    if (wait) return json(res, 429, { error: `Too many failed logins. Try again in ${Math.ceil(wait / 1000)} s.`, retryAfter: Math.ceil(wait / 1000) }, { 'retry-after': String(Math.ceil(wait / 1000)) });
    const b = await readJson(req);
    if (!ADMIN_PASSWORD || !safeEq(String(b.password || ''), ADMIN_PASSWORD)) {
      const locked = loginLimiter.fail(key);
      if (locked) return json(res, 429, { error: `Too many failed logins. Try again in ${Math.ceil(locked / 1000)} s.`, retryAfter: Math.ceil(locked / 1000) }, { 'retry-after': String(Math.ceil(locked / 1000)) });
      return json(res, 401, { error: 'wrong password' });
    }
    loginLimiter.succeed(key);
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
    return s ? json(res, 200, publicView(s)) : json(res, 404, { error: 'unknown court' });
  }
  // Lobby idle screen + demo mode (read-only): the game days from today on (league time) with the first tip-off.
  if (p === '/api/public/game-days') {
    const today = localDate(Date.now());
    const { rows } = await pool.query(`SELECT to_char((scheduled_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS date, to_char(min(scheduled_at AT TIME ZONE $1), 'HH24:MI') AS first, count(*)::int AS games
      FROM games WHERE scheduled_at IS NOT NULL AND (scheduled_at AT TIME ZONE $1)::date >= $2::date GROUP BY 1 ORDER BY 1 LIMIT 60`, [LEAGUE_TZ, today]);
    return json(res, 200, { today, days: rows });
  }
  if (p === '/api/public/schedule') {
    return json(res, 200, publicView(await scheduleSnapshot(resolveScheduleDay({ day: u.searchParams.get('day'), date: u.searchParams.get('date') }, Date.now()))));
  }
  // Mon–Thu practice displays: the fixed weekly schedule + league-local "now" (day of week 0–6, HH:MM).
  if (p === '/api/public/practice') {
    const now = (await pool.query(`SELECT extract(isodow FROM $2::timestamptz AT TIME ZONE $1)::int % 7 AS dow, to_char($2::timestamptz AT TIME ZONE $1, 'HH24:MI') AS hm, to_char($2::timestamptz AT TIME ZONE $1, 'YYYY-MM-DD') AS date`, [LEAGUE_TZ, new Date()])).rows[0];
    const sched = await loadPractice(pool);
    return json(res, 200, { serverNow: Date.now(), now: { dow: now.dow, hm: now.hm, date: now.date }, days: sched.days,
      basketball: sched.basketball.map(({ teamId, ...x }) => x), cheer: sched.cheer.map(({ squadId, slotId, ...x }) => x) });
  }
  // ---- everything below needs the admin session
  if (!validToken(tokenFrom(req))) return json(res, 401, { error: 'admin login required' });
  if (p === '/api/me') return json(res, 200, { role: 'admin', tz: process.env.TZ || 'UTC' });
  if (p === '/api/practice' && m === 'GET') {
    const teams = (await pool.query(`SELECT id, name, grade, gender, coach FROM teams ORDER BY grade_order NULLS LAST, grade, gender, lower(name)`)).rows;
    const squads = (await pool.query(`SELECT id, name, coach FROM cheer_squads ORDER BY lower(name)`)).rows;
    return json(res, 200, { ...(await loadPractice(pool)), teams, squads });
  }
  if (p === '/api/practice' && m === 'PUT') {
    const body = await readJson(req).catch(() => null);
    // A well-formed week is { days: [], basketball: [], cheer: [] }; clearing the week needs exactly that (all empty).
    if (!body || typeof body !== 'object' || Array.isArray(body) || !['days', 'basketball', 'cheer'].every((k) => Array.isArray(body[k]))) {
      const e = 'malformed practice schedule: send { days: [...], basketball: [...], cheer: [...] }';
      return json(res, 400, { error: e, errors: [e] });
    }
    const { schedule, errors } = validatePractice(body);
    if (errors.length) return json(res, 400, { error: errors[0], errors });
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query('LOCK TABLE practice_slots IN EXCLUSIVE MODE');
      // QA r17: never drop teams/squads silently. Removing any saved slot needs confirmRemove: true.
      const dropped = droppedSlots(await loadPractice(client), schedule);
      if (dropped.length && body.confirmRemove !== true) { await client.query('ROLLBACK');
        return json(res, 409, { error: `this save removes ${dropped.length} practice slot(s); send confirmRemove: true to remove them`, errors: dropped, removed: dropped.length }); }
      await savePractice(client, schedule); await client.query('COMMIT'); }
    catch (e: any) { await client.query('ROLLBACK'); if (e.code === '23503') return json(res, 400, { error: 'unknown team or cheer squad', errors: ['unknown team or cheer squad (reload the page; it may have been deleted)'] }); throw e; }
    finally { client.release(); }
    return json(res, 200, { ok: true, ...(await loadPractice(pool)) });
  }

  if (seg[1] === 'teams') {
    const id = seg[2] ? Number(seg[2]) : undefined;
    if (m === 'GET') return json(res, 200, (await pool.query('SELECT id, name, short_name, grade, grade_order, gender, coach, primary_color, secondary_color, logo_url, (logo_data IS NOT NULL) AS has_logo FROM teams ORDER BY grade_order, grade NULLS LAST, gender NULLS LAST, lower(name)')).rows);
    if (m === 'POST') return json(res, 201, { id: await upsertTeam(await readJson(req)) });
    if (m === 'PUT' && id) { await upsertTeam(await readJson(req), id); await refreshAllCourts(); return json(res, 200, { id }); }
    if (m === 'DELETE' && id) {
      const t = (await pool.query('SELECT name, (SELECT count(*)::int FROM games WHERE home_team_id=$1 OR away_team_id=$1) AS n FROM teams WHERE id=$1', [id])).rows[0];
      if (!t) return json(res, 404, { error: 'team not found' });
      if (t.n > 0) return json(res, 409, { error: `"${t.name}" is in ${t.n} game${t.n === 1 ? '' : 's'}. Delete or change those games first, then delete the team.` });
      await pool.query('DELETE FROM teams WHERE id=$1', [id]); return json(res, 200, { ok: true });
    }
  }
  if (seg[1] === 'courts') {
    const id = seg[2] ? Number(seg[2]) : undefined;
    // Weekly scorekeeper QR codes (print view in Admin > Courts)
    if (id && seg[3] === 'qr') {
      if (m === 'POST' && (seg[4] === 'regenerate' || seg[4] === 'revoke')) await pool.query('UPDATE courts SET qr_version = qr_version + 1 WHERE id=$1', [id]);
      const c = (await pool.query('SELECT * FROM courts WHERE id=$1', [id])).rows[0];
      if (!c) throw new HttpError(404, 'court not found');
      if (m === 'POST') { // sign out phones that signed in with an older QR code of this court (PIN sessions stay)
        for (const cl of clients) if (cl.court === c.slug && cl.role === 'score' && cl.authed && cl.qrVer != null && cl.qrVer !== c.qr_version) {
          cl.authed = false; cl.qrVer = null; send(cl, { type: 'auth', ok: false, needPin: true, sessionRevoked: true, error: REVOKED_MSG });
        }
        void broadcastCourt(c.slug);
      }
      if (seg[4] === 'revoke') return json(res, 200, { ok: true, version: c.qr_version });
      return json(res, 200, await courtQr(c, req));
    }
    if (m === 'GET') return json(res, 200, (await pool.query('SELECT * FROM courts ORDER BY id')).rows.map((c) => ({ ...c, has_pin: COURT_PINS.has(c.slug) })));
    if (m === 'POST') {
      const b = await readJson(req);
      const name = String(b.name || '').trim(); if (!name) throw new Error('name required');
      const slug = String(b.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const r = await pool.query('INSERT INTO courts(slug, name, location, conflicts_with) VALUES ($1,$2,$3,$4) RETURNING id', [slug, name, b.location || null, parseConflicts(b.conflicts_with).filter((s) => s !== slug)]);
      return json(res, 201, { id: r.rows[0].id, slug });
    }
    if (m === 'DELETE' && id) { await pool.query('DELETE FROM courts WHERE id=$1', [id]); return json(res, 200, { ok: true }); }
  }
  if (p === '/api/qr' && m === 'GET') {
    const { rows } = await pool.query('SELECT * FROM courts ORDER BY id');
    return json(res, 200, await Promise.all(rows.map((c) => courtQr(c, req))));
  }
  if (p === '/api/settings/season') {
    if (m === 'GET') return json(res, 200, season);
    if (m === 'PUT') {
      const b = await readJson(req);
      const dark = color(b.dark, null, 'dark'), light = color(b.light, null, 'light');
      if (!dark || !light) throw new HttpError(400, `dark and light are required; ${COLOR_HELP}`);
      if (lum(dark) >= lum(light)) throw new HttpError(400, 'the dark color must be darker than the light color');
      const name = String(b.name ?? season.name).trim().slice(0, 40) || season.name;
      for (const [k, v] of [['season_name', name], ['season_dark', dark], ['season_light', light]]) await pool.query('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
      await loadSeason(); await refreshAllCourts();
      return json(res, 200, season);
    }
  }
  if (seg[1] === 'games') {
    const id = seg[2] ? Number(seg[2]) : undefined;
    if (m === 'GET' && !id) {
      const { rows } = await pool.query(`SELECT g.id, g.court_id, c.name AS court, g.scheduled_at, g.division, g.status, g.theme,
        g.home_team_id, h.name AS home, g.away_team_id, a.name AS away, COALESCE(h.grade, a.grade) AS grade, COALESCE(h.gender, a.gender) AS gender, concat_ws(' ', COALESCE(h.grade, a.grade), COALESCE(h.gender, a.gender)) AS label, LEAST(h.grade_order, a.grade_order) AS grade_order,
        COALESCE(g.final_home, (g.history->'present'->'home'->>'score')::int, 0) AS home_score,
        COALESCE(g.final_away, (g.history->'present'->'away'->>'score')::int, 0) AS away_score,
        (c.current_game_id = g.id) AS on_court, g.moved_from, g.duration_min, g.swap_colors, g.home_locker, g.away_locker, h.coach AS home_coach, a.coach AS away_coach,
        cs.id AS cheer_slot_id, cs.locker AS cheer_locker, cq.id AS cheer_squad_id, cq.name AS cheer, cq.coach AS cheer_coach, cq.logo_url AS cheer_logo_url, (cq.logo_data IS NOT NULL) AS cheer_has_logo
        FROM games g JOIN teams h ON h.id=g.home_team_id JOIN teams a ON a.id=g.away_team_id LEFT JOIN courts c ON c.id=g.court_id
        ${CHEER_JOIN}
        ORDER BY g.scheduled_at NULLS LAST, g.id`);
      const warn = await loadWarnings();
      for (const r of rows) r.warnings = warn.filter((w) => w.gameId === r.id).map((w) => w.message);
      return json(res, 200, rows);
    }
    if (m === 'POST' && !id) {
      const b = await readJson(req);
      if (!b.home_team_id || !b.away_team_id || b.home_team_id === b.away_team_id) throw new Error('pick two different teams');
      const gmis = await gradeCheck(b.home_team_id, b.away_team_id, null);
      if (gmis) throw new HttpError(400, `Can't schedule: ${gmis}.`);
      let r;
      const dur = parseMinutes(b.duration_min);
      const ts = b.scheduled_at ? await tsOf(b.scheduled_at) : null;
      if (ts) { // same rules as reschedule / edit: Fri/Sat + tip-off window, shared floor, same court, team double-booked
        const lt = await leagueLocal(ts); const errs = gameTimeErrors(lt.d, lt.t);
        const clash = await floorConflict(b.court_id || null, ts, dur, null); if (clash) errs.push(clash);
        errs.push(...await slotConflicts(pool, b.court_id || null, ts, dur, null, [Number(b.home_team_id), Number(b.away_team_id)]));
        if (errs.length) throw Object.assign(new HttpError(409, `Can't schedule: ${errs[0]}`), { extra: { errors: errs } });
      }
      try {
        r = await pool.query('INSERT INTO games(court_id, home_team_id, away_team_id, scheduled_at, division, theme, rules, duration_min) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
          [b.court_id || null, b.home_team_id, b.away_team_id, ts, b.division || null, sanitizeTheme(b.theme), b.rules || {}, dur]);
      } catch (e: any) {
        if (/duplicate key/.test(e.message)) throw new HttpError(409, 'That game (same court, time and teams) is already scheduled.');
        throw e;
      }
      // Validate cheer logos before anything else is written? decodeLogo throws HttpError(400/413) on bad input.
      try { await gameExtrasFromBody(r.rows[0].id, b); } catch (e) { await pool.query('DELETE FROM games WHERE id=$1', [r.rows[0].id]); throw e; }
      scheduleChanged();
      return json(res, 201, { id: r.rows[0].id, warnings: await warningsFor(r.rows[0].id) });
    }
    if (m === 'PUT' && id && seg.length === 3) {
      const b = await readJson(req);
      if ('court_id' in b || 'scheduled_at' in b || 'duration_min' in b) { // edit time / court / length
        const g = (await pool.query('SELECT court_id, scheduled_at, duration_min, home_team_id, away_team_id FROM games WHERE id=$1', [id])).rows[0];
        if (!g) throw new HttpError(404, 'game not found');
        const court = 'court_id' in b ? (b.court_id || null) : g.court_id;
        const ts = 'scheduled_at' in b ? (b.scheduled_at ? await tsOf(b.scheduled_at) : null) : g.scheduled_at;
        // QA r17: a plain edit that changes the time follows the reschedule rules (Fri/Sat, game hours) and is audited.
        const moved = !!ts && +new Date(ts) !== +new Date(g.scheduled_at ?? 0);
        if (moved) {
          const lt = (await pool.query(`SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS d, to_char($1::timestamptz AT TIME ZONE $2, 'HH24:MI') AS t`, [ts, LEAGUE_TZ])).rows[0];
          const errs = gameTimeErrors(lt.d, lt.t);
          if (errs.length) throw Object.assign(new HttpError(409, `Can't move: ${errs[0]}`), { extra: { errors: errs } });
        }
        const dur = 'duration_min' in b ? parseMinutes(b.duration_min) : g.duration_min;
        const clash = await floorConflict(court, ts, dur, id);
        if (clash) throw new HttpError(409, `Can't move: ${clash}.`);
        // Same court + team double-booking (reschedule plan): also enforced on the plain edit.
        const teamsNow = [Number(b.home_team_id || g.home_team_id), Number(b.away_team_id || g.away_team_id)];
        const more = await slotConflicts(pool, court, ts, dur, id, teamsNow);
        if (more.length) throw new HttpError(409, `Can't move: ${more[0]}.`);
        try { await pool.query(`UPDATE games SET court_id=$2, scheduled_at=$3, duration_min=$4${moved && g.scheduled_at ? ', moved_from=COALESCE(moved_from, scheduled_at)' : ''} WHERE id=$1`, [id, court, ts, dur]); }
        catch (e: any) { if (/duplicate key/.test(e.message)) throw new HttpError(409, 'That game (same court, time and teams) is already scheduled.'); throw e; }
        if (moved || court !== g.court_id) await logGameEdit(id, g, { court_id: court, scheduled_at: ts, duration_min: dur }, moved && g.scheduled_at ? 'reschedule' : 'edit');
        await refreshAllCourts();
      }
      if ('theme' in b) await pool.query('UPDATE games SET theme=$2 WHERE id=$1', [id, sanitizeTheme(b.theme)]);
      if ('division' in b) await pool.query('UPDATE games SET division=$2 WHERE id=$1', [id, String(b.division || '').trim() || null]);
      if (b.home_team_id && b.away_team_id) {
        if (Number(b.home_team_id) === Number(b.away_team_id)) throw new HttpError(400, 'pick two different teams');
        const gmis = await gradeCheck(b.home_team_id, b.away_team_id, null);
        if (gmis) throw new HttpError(400, `Can't save: ${gmis}.`);
        await pool.query('UPDATE games SET home_team_id=$2, away_team_id=$3 WHERE id=$1', [id, b.home_team_id, b.away_team_id]);
      }
      await gameExtrasFromBody(id, b);
      // Every court, not just the one playing this game: TVs/overlays also show it in Up next / Today, so a color
      // or name change must reach them live (and the schedule screens via scheduleChanged).
      await refreshAllCourts(); scheduleChanged(); return json(res, 200, { id, warnings: await warningsFor(id) });
    }
    if (m === 'DELETE' && id) { runtimes.delete(id); await pool.query('DELETE FROM games WHERE id=$1', [id]); await refreshAllCourts(); return json(res, 200, { ok: true }); }
    if (m === 'POST' && id && seg[3] === 'start') { // admin "Start on court" (force = start anyway despite the shared floor)
      const sb = await readJson(req).catch(() => ({} as any));
      await activateGame(id, null, 'admin', !!sb?.force);
      const slug = (await pool.query('SELECT c.slug FROM games g JOIN courts c ON c.id=g.court_id WHERE g.id=$1', [id])).rows[0].slug;
      return json(res, 200, { ok: true, court: slug });
    }
    if (m === 'POST' && id && seg[3] === 'complete') { // admin force-complete (locks the final score)
      await mutate(id, 'admin', null, (h) => dispatch(h, { type: 'END_GAME' }, Date.now()), { type: 'END_GAME', by: 'admin' });
      await refreshAllCourts(); return json(res, 200, { ok: true });
    }
    if (m === 'POST' && id && seg[3] === 'reopen') { // admin reopen a completed game (becomes active again)
      const sb = await readJson(req).catch(() => ({} as any));
      const st = (await pool.query('SELECT status FROM games WHERE id=$1', [id])).rows[0]?.status;
      if (st !== 'complete') throw new HttpError(409, 'Only a complete game can be reopened.');
      await activateGame(id, null, 'admin', !!sb?.force, true);
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && id && seg[3] === 'reschedule') return json(res, 200, await rescheduleGame(id, await readJson(req)));
    if (m === 'GET' && id && seg[3] === 'changes') {
      return json(res, 200, (await pool.query('SELECT id, at, actor, kind, before, after, reason FROM game_changes WHERE game_id=$1 ORDER BY id', [id])).rows);
    }
    if (m === 'GET' && id && seg[3] === 'events') {
      return json(res, 200, (await pool.query('SELECT seq, actor, command, created_at FROM game_events WHERE game_id=$1 ORDER BY id', [id])).rows);
    }
  }
  if (seg[1] === 'cheer-squads') {
    const id = seg[2] ? Number(seg[2]) : undefined;
    if (m === 'GET' && !id) return json(res, 200, (await pool.query(`SELECT q.id, q.name, q.coach, q.logo_url, (q.logo_data IS NOT NULL) AS has_logo,
      (SELECT count(*)::int FROM cheer_slots s WHERE s.squad_id=q.id) AS slots FROM cheer_squads q ORDER BY lower(q.name)`)).rows);
    if (m === 'POST' && !id) { const nid = await upsertSquad(await readJson(req)); scheduleChanged(); return json(res, 201, { id: nid }); }
    if (m === 'PUT' && id) { await upsertSquad(await readJson(req), id); await refreshAllCourts(); scheduleChanged(); return json(res, 200, { id }); }
    if (m === 'DELETE' && id) {
      const q = (await pool.query('SELECT name, (SELECT count(*)::int FROM cheer_slots WHERE squad_id=$1) AS n FROM cheer_squads WHERE id=$1', [id])).rows[0];
      if (!q) return json(res, 404, { error: 'cheer squad not found' });
      if (q.n > 0) return json(res, 409, { error: `"${q.name}" cheers in ${q.n} time slot${q.n === 1 ? '' : 's'}. Remove or change those slots first, then delete the squad.` });
      await pool.query('DELETE FROM cheer_squads WHERE id=$1', [id]); return json(res, 200, { ok: true });
    }
  }
  // Pick a squad for a cheer-slot-conflict (L2): the candidate may be a legacy name that is not a squad yet, so
  // create it by name (no coach: the legacy per-game data has none), then set the slot, in one transaction.
  // Idempotent: a second click finds the squad and the slot already set and changes nothing.
  if (p === '/api/cheer-slots/pick' && m === 'POST') {
    const b = await readJson(req);
    const date = String(b.date || '').trim(), name = String(b.squad || '').trim().slice(0, 40);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    let start: string; try { start = hourSlot(String(b.time ?? '')); } catch (e: any) { throw new HttpError(400, e.message); }
    if (!name) throw new HttpError(400, 'squad name required');
    const exists = (await pool.query('SELECT 1 FROM cheer_squads WHERE lower(name)=lower($1)', [name])).rowCount;
    if (!exists && !(await legacyCheerConflicts()).some((c) => c.date === date && c.start === start && c.candidates.some((x) => x.toLowerCase() === name.toLowerCase())))
      throw new HttpError(400, `"${name}" is not a cheer squad or a candidate for the ${date} ${start} slot`);
    const client = await pool.connect();
    let sid: number, changed: boolean;
    try {
      await client.query('BEGIN');
      sid = await squadId(client, name);
      changed = await setSlotSquad(client, date, start, sid);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    if (changed) { await refreshAllCourts(); scheduleChanged(); }
    return json(res, 200, { squad_id: sid, created: !exists, changed, date, time: start });
  }
  if (seg[1] === 'cheer-slots') {
    const id = seg[2] ? Number(seg[2]) : undefined;
    if (m === 'GET' && !id) {
      const d = u.searchParams.get('date');
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'date must be YYYY-MM-DD');
      return json(res, 200, (await pool.query(`${SLOT_SELECT} ${d ? 'WHERE s.date=$1::date' : ''} ORDER BY s.date, s.slot_start`, d ? [d] : [])).rows);
    }
    if (m === 'POST' && !id) {
      const v = await slotValues(await readJson(req));
      try {
        const r = await pool.query('INSERT INTO cheer_slots(date, slot_start, squad_id, locker) VALUES ($1,$2,$3,$4) RETURNING id', [v.date, v.start, v.sid, v.locker ?? null]);
        await refreshAllCourts(); scheduleChanged(); return json(res, 201, { id: r.rows[0].id, time: v.start });
      } catch (e: any) { if (/duplicate key/.test(e.message)) throw new HttpError(409, `The ${v.date} ${v.start} slot already has a cheer squad; edit that slot instead.`); throw e; }
    }
    if (m === 'PUT' && id) {
      const b = await readJson(req);
      const ex = (await pool.query(`${SLOT_SELECT} WHERE s.id=$1`, [id])).rows[0];
      if (!ex) throw new HttpError(404, 'cheer slot not found');
      const v = await slotValues({ date: ex.date, time: ex.time, squad_id: ex.squad_id, ...b });
      try { await pool.query('UPDATE cheer_slots SET date=$2, slot_start=$3, squad_id=$4, locker=CASE WHEN $6 THEN $5 ELSE locker END WHERE id=$1', [id, v.date, v.start, v.sid, v.locker ?? null, v.locker !== undefined]); }
      catch (e: any) { if (/duplicate key/.test(e.message)) throw new HttpError(409, `The ${v.date} ${v.start} slot already has a cheer squad.`); throw e; }
      await refreshAllCourts(); scheduleChanged(); return json(res, 200, { id });
    }
    if (m === 'DELETE' && id) { await pool.query('DELETE FROM cheer_slots WHERE id=$1', [id]); await refreshAllCourts(); scheduleChanged(); return json(res, 200, { ok: true }); }
  }
  if (p === '/api/warnings' && m === 'GET') return json(res, 200, await loadWarnings());
  if (p === '/api/export/cheer_squads.csv') {
    const { rows } = await pool.query(`SELECT name, coach, CASE WHEN logo_data IS NOT NULL THEN $1 || '/logos/squad/' || id ELSE logo_url END AS logo FROM cheer_squads ORDER BY lower(name)`, [baseUrl(req)]);
    return csvOut(res, 'cheer_squads.csv', toCsv(['name', 'coach', 'logo'], rows));
  }
  if (p === '/api/export/cheer_slots.csv') {
    const { rows } = await pool.query(`SELECT date, time, squad, locker FROM (${SLOT_SELECT}) x ORDER BY date, time`);
    return csvOut(res, 'cheer_slots.csv', toCsv(['date', 'time', 'squad', 'locker'], rows));
  }
  if (p === '/api/import/cheer_squads.csv' && m === 'POST') { const r = await importCheerSquads(await readBody(req)); await refreshAllCourts(); scheduleChanged(); return json(res, 200, r); }
  if (p === '/api/import/cheer_slots.csv' && m === 'POST') { const r = await importCheerSlots(await readBody(req)); await refreshAllCourts(); scheduleChanged(); return json(res, 200, r); }
  if (p === '/api/export/teams.csv') {
    const { rows } = await pool.query('SELECT name, short_name, grade, gender, coach, logo_url FROM teams ORDER BY grade_order, grade NULLS LAST, gender NULLS LAST, lower(name)');
    return csvOut(res, 'teams.csv', toCsv(['name', 'short_name', 'grade', 'gender', 'coach', 'logo_url'], rows));
  }
  if (p === '/api/export/schedule.csv') {
    const { rows } = await pool.query(`SELECT g.id, to_char(g.scheduled_at AT TIME ZONE current_setting('TimeZone'),'YYYY-MM-DD') AS date,
      to_char(g.scheduled_at AT TIME ZONE current_setting('TimeZone'),'HH24:MI') AS time, COALESCE(c.slug,'') AS court, g.division,
      h.name AS home, a.name AS away,
      CASE WHEN g.status='scheduled' THEN NULL ELSE COALESCE(g.final_home, (g.history->'present'->'home'->>'score')::int) END AS home_score,
      CASE WHEN g.status='scheduled' THEN NULL ELSE COALESCE(g.final_away, (g.history->'present'->'away'->>'score')::int) END AS away_score, g.status, g.duration_min AS minutes, COALESCE(h.grade, a.grade) AS grade, COALESCE(h.gender, a.gender) AS gender,
      CASE WHEN g.swap_colors THEN 'true' ELSE '' END AS swap_colors, g.home_locker, g.away_locker,
      to_char(g.moved_from AT TIME ZONE current_setting('TimeZone'),'YYYY-MM-DD') AS moved_from_date, to_char(g.moved_from AT TIME ZONE current_setting('TimeZone'),'HH24:MI') AS moved_from_time
      FROM games g JOIN teams h ON h.id=g.home_team_id JOIN teams a ON a.id=g.away_team_id LEFT JOIN courts c ON c.id=g.court_id
      ORDER BY g.scheduled_at NULLS LAST, g.id`);
    // Cheer is no longer a schedule column: it is per time slot (cheer_slots.csv).
    return csvOut(res, 'schedule.csv', toCsv(['id', 'date', 'time', 'court', 'division', 'home', 'away', 'home_score', 'away_score', 'status', 'minutes', 'grade', 'gender', 'swap_colors', 'home_locker', 'away_locker', 'moved_from_date', 'moved_from_time'], rows));
  }
  if (p === '/api/import/teams.csv' && m === 'POST') { const r = await importTeams(await readBody(req)); await refreshAllCourts(); return json(res, 200, r); }
  if (p === '/api/export/courts.csv') {
    const { rows } = await pool.query(`SELECT slug, name, location, array_to_string(conflicts_with, ' ') AS conflicts_with FROM courts ORDER BY id`);
    return csvOut(res, 'courts.csv', toCsv(['slug', 'name', 'location', 'conflicts_with'], rows));
  }
  if (p === '/api/import/courts.csv' && m === 'POST') { const r = await importCourts(await readBody(req)); await refreshAllCourts(); return json(res, 200, r); }
  if (p === '/api/import/schedule.csv' && m === 'POST') { const r = await importSchedule(await readBody(req)); await refreshAllCourts(); return json(res, 200, r); }
  json(res, 404, { error: 'not found' });
}

function sanitizeTheme(t: any) {
  const o: Record<string, string> = {};
  if (!t || typeof t !== 'object') return o;
  for (const side of ['home', 'away']) {
    if (t[`${side}Name`]) o[`${side}Name`] = String(t[`${side}Name`]).slice(0, 30);
    // A bad color is a 400 (it used to be dropped silently, which wiped the override on save).
    for (const k of [`${side}Color`, `${side}Accent`]) { const c = color(t[k], null, k); if (c) o[k] = c; }
    if (t[`${side}Logo`]) o[`${side}Logo`] = safeLogoUrl(t[`${side}Logo`])!;
  }
  return o;
}
function csvOut(res: http.ServerResponse, name: string, body: string) {
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` });
  res.end(body);
}

const PAGES: [RegExp, string][] = [
  [/^\/$/, 'index.html'], [/^\/admin\/?$/, 'admin.html'],
  // Practice TVs (Mon–Thu): /upwardbasketballscores/practice/{cheer,basketball}, alias /practice/...; editor /admin/practice.
  [/^\/(?:upwardbasketballscores\/)?practice\/(?:cheer|basketball)\/?$/, 'practice.html'], [/^\/admin\/practice\/?$/, 'practice-admin.html'],
  // Lobby TV (live + next per court, cheer per slot, lockers, coaches): /upwardbasketballscores/lobby, alias /lobby.
  // Before the <slug>court rule. The old full-day schedule screen (/schedule) was retired 2026-10-20 and 404s.
  // Lobby TV v2 (live + next per court, cheer per slot, lockers, coaches): /upwardbasketballscores/lobby, alias /lobby.
  [/^\/upwardbasketballscores\/lobby\/?$/, 'lobby.html'], [/^\/lobby\/?$/, 'lobby.html'],
  [/^\/score\/[\w-]+\/?$/, 'score.html'], [/^\/tv\/split\/?$/, 'split.html'], [/^\/upwardbasketballscores\/split\/?$/, 'split.html'],
  // Fixed TV links: /upwardbasketballscores/{fullcourt,westcourt,eastcourt}[/overlay] (any court: <slug>court)
  [/^\/upwardbasketballscores\/[\w-]+\/overlay\/?$/, 'overlay.html'], [/^\/upwardbasketballscores\/[\w-]+\/?$/, 'tv.html'], [/^\/tv\/[\w-]+\/?$/, 'tv.html'], [/^\/overlay\/[\w-]+\/?$/, 'overlay.html'],
];

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  try {
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    const cm = /^\/logos\/cheer\/(\d+)(?:\/(?:home|away))?$/.exec(u.pathname); // one squad per game; old /home|/away links still work
    if (cm) {
      const r = (await pool.query(`SELECT cheer_logo_data AS d, cheer_logo_mime AS m FROM games WHERE id=$1`, [Number(cm[1])])).rows[0];
      if (!r?.d || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(r.m)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': r.m, 'cache-control': 'public, max-age=60', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return res.end(r.d);
    }
    const sm = /^\/logos\/squad\/(\d+)$/.exec(u.pathname); // cheer squad uploads (moved from games.cheer_logo_*)
    if (sm) {
      const r = (await pool.query('SELECT logo_data AS d, logo_mime AS m FROM cheer_squads WHERE id=$1', [Number(sm[1])])).rows[0];
      if (!r?.d || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(r.m)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': r.m, 'cache-control': 'public, max-age=60', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return res.end(r.d);
    }
    const lm = /^\/logos\/(\d+)$/.exec(u.pathname);
    if (lm) {
      const r = (await pool.query('SELECT logo_data, logo_mime FROM teams WHERE id=$1', [Number(lm[1])])).rows[0];
      if (!r?.logo_data || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(r.logo_mime)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': r.logo_mime, 'cache-control': 'public, max-age=60', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return res.end(r.logo_data);
    }
    // Mascot logos (deliverables/logos): immutable-ish static PNGs, cached a day.
    if (u.pathname.startsWith('/team-logos/')) {
      const f = logoFile(u.pathname);
      if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': fs.statSync(f).size, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(f).pipe(res);
    }
    // Retired full-day schedule screen: 404 like any unknown path (the /upwardbasketballscores/<slug> TV rule would match it).
    if (/^\/(upwardbasketballscores\/)?schedule\/?$/.test(u.pathname)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    const page = PAGES.find(([re]) => re.test(u.pathname));
    let file = page ? page[1] : u.pathname.replace(/^\/+/, '');
    const full = path.resolve(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const code = e instanceof HttpError ? e.status : /duplicate key/.test(msg) ? 409 : /foreign key/.test(msg) ? 400 : /required|must|pick|larger|assign|JSON|too large|unknown/.test(msg) ? 400 : 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) json(res, code, { error: code === 500 ? 'server error' : msg, ...(code !== 500 && e?.extra ? e.extra : {}) }, code === 413 ? { connection: 'close' } : {});
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
  if (process.env.SEED === 'demo' && (await seedDemo('if-needed'))) console.log('Seeded laptop demo data for today.\n' + formatReport(await loadLogos(pool)));
  await migrateColors(); // seeds write lowercase hex; normalize to #RRGGBB (idempotent)
  await loadSeason();
  attachWs(server);
  server.listen(PORT, () => console.log(`Scoreboard listening on :${(server.address() as any)?.port ?? PORT}`)); // PORT=0 -> OS-picked port (tests)
}
main().catch((e) => { console.error(e); process.exit(1); });
