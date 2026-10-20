// Regenerate the example CSVs (deliverables/sheets-templates and samples) from the demo seed plan:
// teams.csv, schedule.csv, cheer_squads.csv, cheer_slots.csv.
// Usage: npm run build && node scripts/gen-templates.mjs [YYYY-MM-DD friday]   (default: the demo weekend for today, America/Chicago)
import fs from 'node:fs';
import { demoSeedPlan, demoWeekend, addDays, hourSlot } from '../dist/src/schedule.js';
const fri = process.argv[2] || demoWeekend(Date.now(), 'America/Chicago').fri;
const plan = demoSeedPlan({ fri, sat: addDays(fri, 1) });
// Example first names (one coach per team for the season; pages show "Coach <name>").
const COACHES = ['Mike', 'Sarah', 'David', 'Rachel', 'Chris', 'Amy', 'Josh', 'Laura', 'Ben', 'Katie', 'Matt', 'Emily', 'Tyler', 'Megan', 'Ryan', 'Hannah'];
// Example locker rooms (they change every week): CH (church hall) and numbered rooms.
const ROOMS = ['CH', '1', '2', '3', '4', '5'];
const teams = ['name,short_name,grade,gender,coach,logo_url'];
const sched = ['id,date,time,court,grade,gender,division,home,away,minutes,swap_colors,home_locker,away_locker'];
const squads = new Map(), slots = new Map();
let t = 0;
for (const [i, g] of plan.entries()) {
  for (const n of [g.home, g.away]) teams.push(`${n},${n.slice(0, 3).toUpperCase()},${g.grade},${g.gender},${COACHES[t++ % COACHES.length]},`);
  sched.push(`,${g.date},${g.time},${g.court},${g.grade},${g.gender},${g.grade} ${g.gender},${g.home},${g.away},,,${ROOMS[(2 * i) % ROOMS.length]},${ROOMS[(2 * i + 1) % ROOMS.length]}`);
  // Cheer is one squad per time slot (date + hour), shared by every court in that hour.
  if (g.cheer) { squads.set(g.cheer, COACHES[(squads.size * 5 + 3) % COACHES.length]); slots.set(`${g.date},${hourSlot(g.time)}`, g.cheer); }
}
const squadCsv = ['name,coach', ...[...squads].map(([n, c]) => `${n},${c}`)];
const slotCsv = ['date,time,squad,locker', ...[...slots].map(([k, n], i) => `${k},${n},${ROOMS[(i + 1) % ROOMS.length]}`)];
for (const dir of ['deliverables/sheets-templates', 'samples']) {
  fs.writeFileSync(`${dir}/teams.csv`, teams.join('\n') + '\n'); fs.writeFileSync(`${dir}/schedule.csv`, sched.join('\n') + '\n');
  fs.writeFileSync(`${dir}/cheer_squads.csv`, squadCsv.join('\n') + '\n'); fs.writeFileSync(`${dir}/cheer_slots.csv`, slotCsv.join('\n') + '\n');
}
console.log(`wrote ${plan.length} games / ${teams.length - 1} teams / ${squads.size} cheer squads / ${slots.size} cheer slots for Fri ${fri}`);
