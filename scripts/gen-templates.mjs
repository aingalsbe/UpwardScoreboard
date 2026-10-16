// Regenerate the example teams.csv + schedule.csv (deliverables/sheets-templates and samples) from the demo seed plan.
// Usage: npm run build && node scripts/gen-templates.mjs [YYYY-MM-DD friday]   (default: the demo weekend for today, America/Chicago)
import fs from 'node:fs';
import { demoSeedPlan, demoWeekend, addDays } from '../dist/src/schedule.js';
const fri = process.argv[2] || demoWeekend(Date.now(), 'America/Chicago').fri;
const plan = demoSeedPlan({ fri, sat: addDays(fri, 1) });
const teams = ['name,short_name,grade,gender,logo_url'];
const sched = ['id,date,time,court,grade,gender,division,home,away,minutes,swap_colors,cheer,cheer_logo'];
for (const g of plan) {
  for (const n of [g.home, g.away]) teams.push(`${n},${n.slice(0, 3).toUpperCase()},${g.grade},${g.gender},`);
  sched.push(`,${g.date},${g.time},${g.court},${g.grade},${g.gender},${g.grade} ${g.gender},${g.home},${g.away},,,${g.cheer || ''},`);
}
for (const dir of ['deliverables/sheets-templates', 'samples']) {
  fs.writeFileSync(`${dir}/teams.csv`, teams.join('\n') + '\n'); fs.writeFileSync(`${dir}/schedule.csv`, sched.join('\n') + '\n');
}
console.log(`wrote ${plan.length} games / ${teams.length - 1} teams for Fri ${fri}`);
