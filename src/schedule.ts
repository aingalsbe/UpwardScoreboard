// Shared-floor scheduling rules. One gym floor: Full, or West + East at the same time.
// A court lists the courts it can't run alongside (courts.conflicts_with, slugs); the rule is
// symmetric, so Full -> [west, east] is enough. West and East don't list each other, so they may overlap.

/** Default game length in minutes (start time + this = end). Env GAME_MINUTES; per-game games.duration_min overrides. */
export const GAME_MINUTES = (() => { const n = Number(process.env.GAME_MINUTES); return Number.isInteger(n) && n > 0 && n <= 600 ? n : 60; })();

/** Half-open intervals [start, start+min): back-to-back games (10:00-11:00 then 11:00) don't overlap. */
export const overlaps = (aStart: number, aMin: number, bStart: number, bMin: number) =>
  aStart < bStart + bMin * 60_000 && bStart < aStart + aMin * 60_000;

export type CourtRule = { slug: string; conflicts_with?: string[] | null };
export const courtsConflict = (a: CourtRule, b: CourtRule) =>
  a.slug !== b.slug && ((a.conflicts_with || []).includes(b.slug) || (b.conflicts_with || []).includes(a.slug));

/** Parse "west east" / "west;east" / "west,east" into a clean slug list. */
export const parseConflicts = (v: unknown): string[] => {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[\s;,]+/);
  return [...new Set(arr.map((s) => String(s).trim().toLowerCase()).filter((s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)))].sort();
};

// ---- Grades: teams are organized by grade, then name. A game must be within one grade.
const ORD = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
/** "5", "5th", "5th grade", "Grade 5" -> "5th Grade"; "K"/"Kindergarten" -> "Kindergarten"; empty -> null; else trimmed text as-is. */
export function normalizeGrade(v: unknown): string | null {
  const t = String(v ?? '').trim(); if (!t) return null;
  if (/^(k|kg|kinder|kindergarten)$/i.test(t)) return 'Kindergarten';
  const m = /^(?:grade\s*)?(\d{1,2})(?:st|nd|rd|th)?(?:\s*grade)?$/i.exec(t);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `${ORD(Number(m[1]))} Grade`;
  if (t.length > 30) throw Object.assign(new Error(`grade "${t.slice(0, 20)}…" is longer than 30 characters`), { status: 400 });
  return t;
}
/** Sort key: Kindergarten 0, "Nth Grade" N, other labels 99, none 100. */
export function gradeOrder(g: string | null | undefined): number {
  if (!g) return 100;
  if (g === 'Kindergarten') return 0;
  const m = /^(\d{1,2})(st|nd|rd|th) Grade$/.exec(g); return m ? Number(m[1]) : 99;
}
/** null if OK, else a message. Teams without a grade are allowed (legacy data). */
export function gradeMismatch(home: { name: string; grade: string | null }, away: { name: string; grade: string | null }, stated?: string | null): string | null {
  if (home.grade && away.grade && home.grade !== away.grade) return `a game must be within one grade: ${home.name} is ${home.grade}, ${away.name} is ${away.grade}`;
  const g = home.grade || away.grade;
  if (stated && g && stated !== g) return `grade "${stated}" doesn't match the teams (${g})`;
  if (stated && (!home.grade || !away.grade) && [home, away].some((t) => t.grade && t.grade !== stated)) return `grade "${stated}" doesn't match the teams`;
  return null;
}

// ---- Season colors: one dark + one light for every team. Default home = light, away = dark; swap flips it.
export const sideOf = (swap: boolean, side: 'home' | 'away'): 'light' | 'dark' => ((side === 'home') !== !!swap ? 'light' : 'dark');
/** The team color and accent for a side: the side's season color, accented with the other one. */
export const sideColors = (season: { dark: string; light: string }, swap: boolean, side: 'home' | 'away') => {
  const wear = sideOf(swap, side);
  return { side: wear, color: season[wear], accent: season[wear === 'light' ? 'dark' : 'light'] };
};
