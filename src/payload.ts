// Role filters for realtime payloads. Pure, so tests can check them without a server.

/** Deep copy of `v` without any `coach` key, at any depth (arrays and nested objects included). */
export function stripCoaches<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripCoaches) as unknown as T;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== 'coach') o[k] = stripCoaches(x);
    return o as T;
  }
  return v;
}

/**
 * What the bench scorekeeper may see: no cheer squad data (TV/overlay only) and no coach names anywhere
 * (coaches are lobby/TV only). Applied to every message sent to a `score` client.
 */
export function scorekeeperView(msg: any): any {
  if (!msg || typeof msg !== 'object') return msg;
  let m = msg;
  if (m.type === 'state' && m.game) { const { cheer, ...game } = m.game; m = { ...m, game }; }
  return stripCoaches(m);
}

/** True if a `coach` key appears anywhere in `v` (test helper and a last-line guard). */
export function hasCoachKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasCoachKey);
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).some(([k, x]) => k === 'coach' || hasCoachKey(x));
  return false;
}

// ---- Score hiding for young grades (2026-10) -------------------------------------------------------------
// Kindergarten, 1st and 2nd Grade games show NO score on the public screens (TV, overlay, lobby, viewer links and
// the /api/public/* endpoints): only clock and period. The scorekeeper still records the score (game history,
// final_home/final_away, admin + CSV export), so it is stripped here, per role, not at the source.

/** Highest grade (gradeOrder) whose games hide the score publicly: 2 = 2nd Grade and below (K = 0). */
export const HIDE_SCORE_MAX_GRADE = 2;

/** By gradeOrder (legacy helper; the server uses isScoreHiddenGrade in schedule.ts on the raw grade text). */
export function hidesScore(gradeOrderValue: number | null | undefined): boolean {
  return gradeOrderValue != null && gradeOrderValue >= 0 && gradeOrderValue <= HIDE_SCORE_MAX_GRADE;
}

const hideTeam = (t: any) => (t && typeof t === 'object' ? { ...t, score: null } : t);
const hideRow = (r: any) => (r && r.hideScore ? { ...r, final_home: null, final_away: null } : r);

/**
 * What every public (non-scorekeeper) client gets: for games flagged hideScore, all score fields are nulled
 * (game.state.home/away.score, lobby games[].home/away.score, final_home/final_away on lastFinal/today rows).
 */
export function publicView(msg: any): any {
  if (!msg || typeof msg !== 'object' || msg.type !== 'state') return msg;
  const m = { ...msg };
  if (m.game?.hideScore) {
    const st = m.game.state;
    m.game = { ...m.game, ...(st ? { state: { ...st, home: hideTeam(st.home), away: hideTeam(st.away) } } : {}) };
    if ('home' in m.game && m.game.home && 'score' in m.game.home) m.game.home = hideTeam(m.game.home);
    if ('away' in m.game && m.game.away && 'score' in m.game.away) m.game.away = hideTeam(m.game.away);
  }
  if (Array.isArray(m.games)) m.games = m.games.map((g: any) => (g?.hideScore ? { ...g, home: hideTeam(g.home), away: hideTeam(g.away) } : g));
  if (m.lastFinal) m.lastFinal = hideRow(m.lastFinal);
  if (Array.isArray(m.today)) m.today = m.today.map(hideRow);
  return m;
}

/** True if any score value (number) appears under a hideScore game anywhere in the message (test helper). */
export function leaksHiddenScore(v: any, hidden = false): boolean {
  if (Array.isArray(v)) return v.some((x) => leaksHiddenScore(x, hidden));
  if (v && typeof v === 'object') {
    const h = hidden || v.hideScore === true;
    return Object.entries(v).some(([k, x]) => (h && ['score', 'final_home', 'final_away'].includes(k) && x != null) || leaksHiddenScore(x, h));
  }
  return false;
}
