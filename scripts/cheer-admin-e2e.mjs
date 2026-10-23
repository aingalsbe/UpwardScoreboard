// Admin Cheer tab e2e (A2 regression): an unsaved edit in the cheer slot editor survives the 10 s refresh, Save
// stores it, a Coach field round-trips on Teams, and the game editor has locker fields but no cheer fields.
// Usage: [BASE_URL=http://localhost:3000] [ADMIN_PASSWORD=change-me-admin] [CHROME_PATH=/usr/bin/google-chrome] node scripts/cheer-admin-e2e.mjs
import { pinBrowserClock, nextSaturday } from './_gameday.mjs'; // first: shared game-day helper + test clock
import { chromium } from 'playwright-core';
const B = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await pinBrowserClock(p.context());
await p.goto(B + '/admin'); await p.fill('#password', process.env.ADMIN_PASSWORD || 'change-me-admin'); await p.click('#login button');
await p.waitForSelector('#app:not([hidden])');
await p.goto(B + '/admin#schedule');
ok(await p.$('#game-form [name=home_locker]') && await p.$('#game-form [name=away_locker]') && !(await p.$('#game-form [name=cheer]')), 'game editor: Home/Away locker fields, no per-game cheer fields');
await p.goto(B + '/admin#cheer'); await p.waitForSelector('#slot-rows tr[data-slot-hour]');
const date = await p.inputValue('#slot-date');
const row = p.locator('#slot-rows tr[data-slot-hour]').first(); const hour = await row.getAttribute('data-slot-hour');
const squadName = await p.locator('#squad-rows tr td:nth-child(2)').first().textContent();
await row.locator('select').selectOption({ label: squadName }); await row.locator('input[name=locker]').fill('7');
await p.locator('#cheer h2').first().click(); // focus leaves the editor: only slotsDirty keeps the edit now
await p.waitForTimeout(11_500); // the 10 s refresh runs
ok(await row.locator('input[name=locker]').inputValue() === '7' && (await row.locator('select option:checked').textContent()) === squadName, `unsaved slot edit (${date} ${hour}) survives the 10 s refresh (A2)`);
await row.locator('button[data-save-slot]').click(); await p.waitForTimeout(800);
const saved = await (await p.request.get(`${B}/api/cheer-slots?date=${date}`)).json();
ok(saved.some((s) => s.time === hour && s.squad === squadName && s.locker === '7'), `Save stores the slot (${squadName}, locker 7)`);
await p.goto(B + '/admin#teams'); await p.locator('[data-edit-team]').first().click();
await p.fill('#team-form [name=coach]', 'Zed'); await p.click('#team-save'); await p.waitForTimeout(800);
ok(await p.locator('#team-rows', { hasText: 'Coach Zed' }).count() > 0, 'Teams form: coach saved and shown as "Coach Zed"');
await b.close(); console.log(`Cheer admin e2e: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
