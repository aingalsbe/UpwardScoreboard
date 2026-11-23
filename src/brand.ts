// Release 1 (Aaron, 2026-11-23): the league is "Upward Basketball and Cheer" on every screen and tab title.
// Repo, database and package identifiers (UpwardScoreboard, upward-scoreboard, /upwardbasketballscores/) stay as they are.
export const BRAND = 'Upward Basketball and Cheer';

/** "Upward Basketball" -> "Upward Basketball and Cheer" in a display string (env LEAGUE_NAME etc.); idempotent. */
export function brandText(v: string): string {
  return v.replace(/Upward Basketball(?!\s+(?:and|&)\s+Cheer)/gi, (m) => (m === m.toUpperCase() ? BRAND.toUpperCase() : BRAND));
}
