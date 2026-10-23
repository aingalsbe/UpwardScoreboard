// Demo Mon–Thu practice week for an existing database (no reseed). Fills only an empty practice schedule.
//   docker compose exec upward-app node dist/src/seed-practice.js
import { pool, migrate } from './db.js';
import { seedPracticeDemo } from './practice.js';
await migrate();
console.log((await seedPracticeDemo(pool)) ? 'SEEDED demo practice week (Mon–Thu)' : 'SKIPPED: a practice schedule already exists (edit it in Admin > Practice)');
await pool.end();
