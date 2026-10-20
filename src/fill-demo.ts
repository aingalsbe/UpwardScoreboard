// Fill empty demo locker rooms + coaches on an existing DB, in place (never overwrites, never wipes). Idempotent.
// In the running stack: docker compose exec -T app node dist/src/fill-demo.js
import { pool, migrate, fillDemoLockers } from './db.js';

await migrate();
const r = await fillDemoLockers();
console.log(`FILLED team coaches ${r.teamCoaches}, cheer squad coaches ${r.squadCoaches}, game lockers ${r.gameLockers}, cheer slot lockers ${r.slotLockers}`);
await pool.end();
