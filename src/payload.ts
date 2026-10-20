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
