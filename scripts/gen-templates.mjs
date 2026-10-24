// Regenerate the example CSVs (deliverables/sheets-templates and samples) from the demo seed plan:
// teams.csv, schedule.csv, cheer_squads.csv, cheer_slots.csv.
// Usage: npm run build && node scripts/gen-templates.mjs [YYYY-MM-DD friday]   (default: the demo weekend for today, America/Chicago)
import fs from 'node:fs';
import { demoSeedPlan, demoWeekend, divisionLabel, addDays, hourSlot } from '../dist/src/schedule.js';
// Coaches, locker rooms and cheer coach/locker come from the plan (same example data as the demo seed).
const fri = process.argv[2] || demoWeekend(Date.now(), 'America/Chicago').fri;
const plan = demoSeedPlan({ fri, sat: addDays(fri, 1) });
const teams = ['name,short_name,grade,gender,coach,logo_url'];
const sched = ['id,date,time,court,grade,gender,division,home,away,minutes,swap_colors,home_locker,away_locker'];
const squads = new Map(), slots = new Map();
for (const g of plan) {
  const div = divisionLabel(g.grade, g.gender) ?? '', ge = g.gender ?? '';
  for (const [n, c] of [[g.home, g.homeCoach], [g.away, g.awayCoach]]) teams.push(`${n},${n.replace(/^lady\s+/i, '').slice(0, 3).toUpperCase()},${g.grade},${ge},${c},`);
  sched.push(`,${g.date},${g.time},${g.court},${g.grade},${ge},${div},${g.home},${g.away},,,${g.homeLocker},${g.awayLocker}`);
  // Cheer is one squad per time slot (date + hour), shared by every court in that hour.
  if (g.cheer) { squads.set(g.cheer, g.cheerCoach); slots.set(`${g.date},${hourSlot(g.time)}`, [g.cheer, g.cheerLocker]); }
}
const squadCsv = ['name,coach', ...[...squads].map(([n, c]) => `${n},${c}`)];
const slotCsv = ['date,time,squad,locker', ...[...slots].map(([k, [n, l]]) => `${k},${n},${l}`)];
for (const dir of ['deliverables/sheets-templates', 'samples']) {
  fs.writeFileSync(`${dir}/teams.csv`, teams.join('\n') + '\n'); fs.writeFileSync(`${dir}/schedule.csv`, sched.join('\n') + '\n');
  fs.writeFileSync(`${dir}/cheer_squads.csv`, squadCsv.join('\n') + '\n'); fs.writeFileSync(`${dir}/cheer_slots.csv`, slotCsv.join('\n') + '\n');
}
console.log(`wrote ${plan.length} games / ${teams.length - 1} teams / ${squads.size} cheer squads / ${slots.size} cheer slots for Fri ${fri}`);
