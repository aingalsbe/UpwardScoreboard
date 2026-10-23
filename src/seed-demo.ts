// Demo seed CLI. In the running stack: docker compose exec app node dist/src/seed-demo.js [--reset]
// Prints SEEDED or SKIPPED. Restart the app afterwards (docker compose restart app) so open screens reload.
import './test-clock.js'; // first: test-only clock override (SCOREBOARD_TEST_NOW)
import { pool, migrate, seedDemo } from './db.js';
import { demoWeekend } from './schedule.js';
import { loadLogos, formatReport } from './logo-files.js';

const reset = process.argv.includes('--reset');
await migrate();
const did = await seedDemo(reset ? 'reset' : 'if-needed');
const w = demoWeekend(Date.now(), 'America/Chicago');
console.log(did ? `SEEDED demo weekend Fri ${w.fri} + Sat ${w.sat} (America/Chicago)` : `SKIPPED: games already scheduled for the demo weekend ${w.fri}/${w.sat} (use --reset to wipe and reseed)`);
if (did) console.log(formatReport(await loadLogos(pool)));
await pool.end();
