// Load Sage's mascot logos into an existing DB (no reseed). In the stack:
//   docker compose exec upward-app node dist/src/load-logos.js --dry-run
//   docker compose exec upward-app node dist/src/load-logos.js            (fills only empty logos)
//   ... --season    use manifest-2027.json (real 2027 season, exact matches only; also runs automatically on startup)
//   ... --overwrite   replaces existing logos (URL and uploads) with the manifest's. Not needed normally.
import { pool, migrate } from './db.js';
import { loadLogos, formatReport, MANIFEST_2027 } from './logo-files.js';

const args = process.argv.slice(2);
const bad = args.filter((a) => !['--dry-run', '--overwrite', '--force', '--season'].includes(a));
if (bad.length) { console.error(`Unknown option(s): ${bad.join(' ')}\nUsage: node dist/src/load-logos.js [--dry-run] [--overwrite] [--season]`); process.exit(2); }
await migrate();
const r = await loadLogos(pool, { ...(args.includes('--season') ? { manifest: MANIFEST_2027, fallback: false } : {}), dryRun: args.includes('--dry-run'), overwrite: args.includes('--overwrite') || args.includes('--force') });
console.log(formatReport(r));
await pool.end();
