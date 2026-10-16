// Weekly court QR tokens. A token lets a scorekeeper's phone sign in to ONE court until the end of the
// league week (Sunday 23:59:59 in league time). Each court has a token version: regenerating or revoking
// bumps it, which invalidates every older printed code. Format: qr1.<court>.<expMs>.<version>.<hmac>
import crypto from 'node:crypto';

const mac = (secret: string, body: string) => crypto.createHmac('sha256', secret).update('qr:' + body).digest('base64url');

export function makeQrToken(secret: string, court: string, expMs: number, version: number): string {
  const body = `qr1.${court}.${expMs}.${version}`;
  return `${body}.${mac(secret, body)}`;
}

export type QrCheck = { ok: true; court: string; exp: number } | { ok: false; reason: 'malformed' | 'court' | 'signature' | 'expired' | 'revoked' };
/** Verify a token for `court` at time `now` against the court's current version. */
export function verifyQrToken(secret: string, token: unknown, court: string, now: number, currentVersion: number): QrCheck {
  if (typeof token !== 'string' || token.length > 300) return { ok: false, reason: 'malformed' };
  const m = /^qr1\.([a-z0-9-]+)\.(\d{10,15})\.(\d{1,9})\.([\w-]{20,})$/.exec(token);
  if (!m) return { ok: false, reason: 'malformed' };
  const [, c, exp, ver, sig] = m;
  const want = mac(secret, `qr1.${c}.${exp}.${ver}`);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return { ok: false, reason: 'signature' };
  if (c !== court) return { ok: false, reason: 'court' };
  if (Number(exp) < now) return { ok: false, reason: 'expired' };
  if (Number(ver) !== currentVersion) return { ok: false, reason: 'revoked' };
  return { ok: true, court: c, exp: Number(exp) };
}

/** End of the league week containing `now`: Sunday 23:59:59.999 in `tz` (a Sunday counts as its own week's end). */
export function weekEnd(now: number, tz = 'America/Chicago'): number {
  const parts = (t: number) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
    .formatToParts(t).map((p) => [p.type, p.value]));
  const p = parts(now);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const day = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + ((7 - dow) % 7)));
  // local Y-M-D 23:59:59.999 -> UTC, correcting for the zone offset at that moment (twice, for DST edges)
  let guess = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23, 59, 59, 999);
  const want = guess;
  for (let i = 0; i < 2; i++) {
    const q = parts(guess);
    const asUtc = Date.UTC(+q.year, +q.month - 1, +q.day, +q.hour, +q.minute, +q.second, 999);
    guess += want - asUtc;
  }
  return guess;
}
