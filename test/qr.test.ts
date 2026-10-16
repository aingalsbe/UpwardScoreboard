import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeQrToken, verifyQrToken, weekEnd } from '../src/qr.js';

const S = 'test-secret';
test('weekly QR token: valid, wrong court, tampered, expired, revoked', () => {
  const now = Date.UTC(2026, 9, 16, 15); // Fri Oct 16 2026
  const exp = weekEnd(now);
  const t = makeQrToken(S, 'west', exp, 3);
  assert.deepEqual(verifyQrToken(S, t, 'west', now, 3), { ok: true, court: 'west', exp });
  assert.equal((verifyQrToken(S, t, 'east', now, 3) as any).reason, 'court');
  assert.equal((verifyQrToken(S, t.slice(0, -2) + 'xx', 'west', now, 3) as any).reason, 'signature');
  assert.equal((verifyQrToken(S, t.replace('.3.', '.4.'), 'west', now, 4) as any).reason, 'signature'); // can't forge a new version
  assert.equal((verifyQrToken(S, t, 'west', exp + 1, 3) as any).reason, 'expired');
  assert.equal((verifyQrToken(S, t, 'west', now, 4) as any).reason, 'revoked'); // regenerated / revoked
  assert.equal((verifyQrToken(S, 'garbage', 'west', now, 3) as any).reason, 'malformed');
});

test('week ends Sunday 23:59:59 America/Chicago (CDT and CST)', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  assert.equal(iso(weekEnd(Date.UTC(2026, 9, 16, 15))), '2026-10-19T04:59:59.999Z'); // Fri Oct 16 -> Sun Oct 18 23:59:59 CDT
  assert.equal(iso(weekEnd(Date.UTC(2026, 9, 19, 4, 30))), '2026-10-19T04:59:59.999Z'); // Sun 23:30 CDT is still this week
  assert.equal(iso(weekEnd(Date.UTC(2026, 9, 19, 5, 30))), '2026-10-26T04:59:59.999Z'); // Mon 00:30 -> next Sunday
  assert.equal(iso(weekEnd(Date.UTC(2026, 10, 2, 18))), '2026-11-09T05:59:59.999Z'); // after DST ends: CST (-6)
  assert.equal(iso(weekEnd(Date.UTC(2026, 9, 31, 18))), '2026-11-02T05:59:59.999Z'); // week containing the fall-back Sunday
});
