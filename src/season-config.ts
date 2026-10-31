// Real 2027 season constants (Aaron, 2026-10-30). One object: game length, the
// split-court warning window, period rules, and the CSV court names.

export const seasonConfig = {
  /** Every imported game is 60 minutes (tip-off through the next hour). */
  GAME_MINUTES: 60,
  /**
   * West/East games outside this window raise split-outside-hours.
   * Covers the real schedule: Friday 17:15–21:15 and Saturday 08:00–20:00.
   * (A single window is enough: earliest tip is Sat 08:00, latest end is Fri 21:15.)
   */
  SPLIT_START: '08:00',
  SPLIT_END: '21:15',
  SPLIT_START_MIN: 8 * 60,
  SPLIT_END_MIN: 21 * 60 + 15,
  /** 6 periods of 6:00, halftime after P3. */
  PERIODS: 6,
  PERIOD_LENGTH_MS: 6 * 60_000,
  TZ: 'America/Chicago',
  /** Basketball practice_days. Cheer slots have no start time; they share these days. */
  PRACTICE_DAYS: [
    { day: 1, start: '17:00', end: '21:00' },
    { day: 2, start: '17:00', end: '21:00' },
    { day: 3, start: '17:00', end: '21:00' },
    { day: 4, start: '17:00', end: '21:00' },
  ],
  /** Game CSV "FacilityName" (trimmed, lowercased) -> courts.slug. */
  GAME_COURT: {
    'game court - west': 'west',
    'game court - east': 'east',
    'game court - full': 'full',
  } as Record<string, 'west' | 'east' | 'full'>,
  /** Practice CSV facility -> practice_slots.court. */
  PRACTICE_COURT: {
    'west 1': 'west1',
    'west 2': 'west2',
    'east 1': 'east1',
    'east 2': 'east2',
  } as Record<string, 'west1' | 'west2' | 'east1' | 'east2'>,
};

/**
 * Game-day locker rooms (Aaron, 2026-10-30): fixed by court + side, no per-game entry. Derived at read time (server
 * payloads), so changing this needs no re-import. A stored games.home_locker / away_locker or cheer_slots.locker
 * (admin edit, CSV, demo seed) is an override and wins. The display adds the "Locker Room" label.
 */
export const LOCKER_ROOMS = {
  cheer: '1',
  west: { home: 'CH', away: '5' },
  east: { home: '2', away: '3' },
  full: { home: 'CH', away: '5' },
} as const;
/**
 * A stored locker counts as an override only when it names a room: null, blank / whitespace-only and "0" (any number
 * of zeros, e.g. a spreadsheet's "none") mean "no override" and fall back to the rule (QA R28 N3).
 */
export const isLockerOverride = (stored?: string | null): stored is string => {
  const v = stored == null ? '' : String(stored).trim();
  return v !== '' && !/^0+$/.test(v);
};
/** Locker for a team: stored override, else the court rule (null for an unknown/missing court). */
export function teamLocker(court: string | null | undefined, side: 'home' | 'away', stored?: string | null): string | null {
  if (isLockerOverride(stored)) return String(stored).trim();
  const c = court && (LOCKER_ROOMS as any)[court];
  return c && typeof c === 'object' ? c[side] : null;
}
/** Cheer squad locker on game days: stored override, else LOCKER_ROOMS.cheer. */
export const cheerLocker = (stored?: string | null): string => (isLockerOverride(stored) ? String(stored).trim() : LOCKER_ROOMS.cheer);
