// Demo seed CLI. In the running stack: docker compose exec app node dist/src/seed-demo.js [--reset]
// Prints SEEDED or SKIPPED. Restart the app afterwards (docker compose restart app) so open screens reload.
import { pool, migrate, seedDemo } from './db.js';

const reset = process.argv.includes('--reset');
await migrate();
const did = await seedDemo(reset ? 'reset' : 'if-needed');
console.log(did ? 'SEEDED demo data for today (America/Chicago)' : 'SKIPPED: games already scheduled for today (use --reset to wipe and reseed)');
await pool.end();
