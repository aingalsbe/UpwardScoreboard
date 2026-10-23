// TEST-ONLY server clock override (e2e scripts on any weekday; see SETUP.md "Test clock").
// Needs BOTH an explicit opt-in SCOREBOARD_TEST_CLOCK=1 and SCOREBOARD_TEST_NOW=<ISO time>; the clock then starts at
// that instant and keeps ticking. Refused (exit 1) whenever NODE_ENV looks like production (production, prod, PROD…,
// the Docker image sets production), and SCOREBOARD_TEST_NOW without the opt-in flag is also refused, never silent.
// Must be the first import of every entry point (server.ts, seed-demo.ts) so all Date use is shifted.
const raw = process.env.SCOREBOARD_TEST_NOW, flag = process.env.SCOREBOARD_TEST_CLOCK;
export const PROD_LIKE = /^\s*prod/i;
if (raw || flag) {
  const fail = (m: string) => { console.error(m + ' Refusing to start.'); process.exit(1); };
  if (PROD_LIKE.test(process.env.NODE_ENV || '')) fail(`The test clock (SCOREBOARD_TEST_CLOCK / SCOREBOARD_TEST_NOW) is a test-only setting and must not be set in production (NODE_ENV=${process.env.NODE_ENV}).`);
  if (flag !== '1') fail('SCOREBOARD_TEST_NOW needs the explicit opt-in SCOREBOARD_TEST_CLOCK=1 (test clock, tests only).');
  if (!raw) fail('SCOREBOARD_TEST_CLOCK=1 needs SCOREBOARD_TEST_NOW=<ISO time>.');
  const target = Date.parse(raw!);
  if (Number.isNaN(target)) fail(`SCOREBOARD_TEST_NOW="${raw}" is not a date/time.`);
  const R = Date, off = target - R.now();
  class Shifted extends R {
    constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(R.now() + off); }
    static now() { return R.now() + off; }
  }
  (globalThis as any).Date = Shifted;
  console.warn(`TEST CLOCK: time shifted to ${raw} (SCOREBOARD_TEST_CLOCK=1 + SCOREBOARD_TEST_NOW, tests only)`);
}
