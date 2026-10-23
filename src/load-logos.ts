// Load Sage's mascot logos into an existing DB (no reseed). In the stack:
//   docker compose exec upward-app node dist/src/load-logos.js --dry-run
//   docker compose exec upward-app node dist/src/load-logos.js            (fills only empty logos)
//   ... --overwrite   replaces existing logos (URL and uploads) with the manifest's. Not needed normally.
import { pool, migrate } from './db.js';
import { loadLogos, formatReport } from './logo-files.js';

const args = process.argv.slice(2);
const bad = args.filter((a) => !['--dry-run', '--overwrite', '--force'].includes(a));
if (bad.length) { console.error(`Unknown option(s): ${bad.join(' ')}\nUsage: node dist/src/load-logos.js [--dry-run] [--overwrite]`); process.exit(2); }
await migrate();
const r = await loadLogos(pool, { dryRun: args.includes('--dry-run'), overwrite: args.includes('--overwrite') || args.includes('--force') });
console.log(formatReport(r));
await pool.end();
