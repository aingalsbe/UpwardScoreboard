// In-memory brute-force limiter: N failures -> lockout that doubles each time (capped).
export class Limiter {
  private m = new Map<string, { fails: number; lockouts: number; until: number; seen: number }>();
  constructor(public max = 5, public baseMs = 30_000, public maxMs = 15 * 60_000) {}
  /** ms until this key may try again (0 = allowed now). */
  retryAfter(key: string, now = Date.now()): number {
    const e = this.m.get(key);
    return e && e.until > now ? e.until - now : 0;
  }
  /** Record a failure; returns the lockout ms if this failure triggered/extends a lock, else 0. */
  fail(key: string, now = Date.now()): number {
    const e = this.m.get(key) ?? { fails: 0, lockouts: 0, until: 0, seen: now };
    e.seen = now; e.fails++;
    if (e.fails >= this.max) {
      const ms = Math.min(this.maxMs, this.baseMs * 2 ** e.lockouts);
      e.until = now + ms; e.lockouts++; e.fails = 0;
      this.m.set(key, e); return ms;
    }
    this.m.set(key, e); return 0;
  }
  succeed(key: string) { this.m.delete(key); }
  prune(now = Date.now()) { for (const [k, e] of this.m) if (e.until < now && now - e.seen > 3600_000) this.m.delete(k); }
}
