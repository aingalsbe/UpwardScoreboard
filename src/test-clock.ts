// TEST-ONLY server clock override (e2e scripts on any weekday; see SETUP.md "Test clock").
// SCOREBOARD_TEST_NOW=<ISO time> starts the server's clock at that instant (it keeps ticking). Never in production:
// with NODE_ENV=production (the Docker image) the server refuses to start if the variable is set.
// Must be the first import of every entry point (server.ts, seed-demo.ts) so all Date use is shifted.
const raw = process.env.SCOREBOARD_TEST_NOW;
if (raw) {
  if (process.env.NODE_ENV === 'production') { console.error('SCOREBOARD_TEST_NOW is a test-only setting and must not be set in production; refusing to start.'); process.exit(1); }
  const target = Date.parse(raw);
  if (Number.isNaN(target)) { console.error(`SCOREBOARD_TEST_NOW="${raw}" is not a date/time`); process.exit(1); }
  const R = Date, off = target - R.now();
  class Shifted extends R {
    constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(R.now() + off); }
    static now() { return R.now() + off; }
  }
  (globalThis as any).Date = Shifted;
  console.warn(`TEST CLOCK: time shifted to ${raw} (SCOREBOARD_TEST_NOW, tests only)`);
}
export {};
