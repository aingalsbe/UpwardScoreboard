// Release 2 browser E2E + screenshots (headless Chrome / Edge via playwright-core).
// Run against a LOCAL scratch server on a Monday test clock only:
//   - Slot flow (default or MODE=slot): server started at Monday 16:59:50 CST (2026-11-30T22:59:50Z)
//   - DEVO buzz flow (MODE=devo, or DEVO_BASE_URL): server started at Monday 17:24:50 CST (2026-11-30T23:24:50Z)
// Usage:
//   BASE_URL=http://127.0.0.1:18621 OUT=/path/to/screens CHROME_PATH=/usr/bin/google-chrome node scripts/release2-practice-e2e.mjs
//   BASE_URL=http://127.0.0.1:18622 MODE=devo OUT=/path/to/screens CHROME_PATH=/usr/bin/google-chrome node scripts/release2-practice-e2e.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18621';
const DEVO_BASE = process.env.DEVO_BASE_URL || '';
const MODE = (process.env.MODE || '').toLowerCase(); // 'slot' | 'devo' | '' (auto/both)
for (const u of [BASE, DEVO_BASE].filter(Boolean)) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u)) throw new Error('local scratch server only: ' + u);
}
const OUT = (process.env.OUT || new URL('../release2-screens/', import.meta.url).pathname).replace(/\/?$/, '/');
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' · ' + extra : ''}`;
  results.push(line);
  console.log(line);
};

// Headless Chrome starts AudioContext running by default; emulate real TV autoplay lock until tapped.
const AUTOPLAY_LOCK = `(() => { const R = window.AudioContext; if (!R) return; let g = false;
  for (const ev of ['pointerdown', 'touchstart', 'keydown']) window.addEventListener(ev, () => { g = true; }, { capture: true });
  window.AudioContext = class extends R { get state() { return g ? super.state : 'suspended'; } resume() { return g ? super.resume() : Promise.resolve(); } }; })();`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--autoplay-policy=user-gesture-required'],
});

async function open(base, url, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(AUTOPLAY_LOCK);
  const page = await ctx.newPage();
  await page.goto(base + url);
  await sleep(900);
  return { ctx, page };
}

const TV_1080 = { width: 1920, height: 1080 };
const TV_768 = { width: 1366, height: 768 };
const DESK = { width: 1366, height: 900 };
const shot = (page, f, full = false) => page.screenshot({ path: OUT + f, fullPage: full });

const practiceState = () => ({
  status: document.documentElement.dataset.status,
  practiceMode: document.documentElement.classList.contains('practice-mode'),
  paused: document.documentElement.classList.contains('practice-paused'),
  sound: document.documentElement.dataset.sound,
  gateVisible: (() => { const g = document.getElementById('sound-gate'); return !!g && !g.hidden && getComputedStyle(g).display !== 'none'; })(),
  title: document.querySelector('.practice-title')?.textContent?.trim() || '',
  teams: [...document.querySelectorAll('.practice-team-chip')].map((el) => el.textContent.trim()),
  devo: document.querySelector('[data-practice-clock="devo"]')?.textContent?.trim() || '',
  end: document.querySelector('[data-practice-clock="end"]')?.textContent?.trim() || '',
  hasCoach: /\bCoach\s+/i.test(document.body.innerText),
  clockLow: document.documentElement.classList.contains('clock-low'),
  idleHidden: (() => { const el = document.getElementById('idle'); return !el || getComputedStyle(el).display === 'none'; })(),
  gateClearsClocks: (() => {
    const g = document.getElementById('sound-gate');
    if (!g || g.hidden) return true;
    const gr = g.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.practice-clock-val')].map((el) => el.getBoundingClientRect());
    return cards.every((r) => !(gr.left < r.right && r.left < gr.right && gr.top < r.bottom && r.top < gr.bottom));
  })(),
});

async function runSlotFlow(base) {
  const { page: tvWest } = await open(base, '/westcourt', TV_1080);
  const { page: tvFull } = await open(base, '/fullcourt', TV_768);
  const { page: tvSplit } = await open(base, '/split', TV_1080);

  // Wait up to 16 s for 16:59:50 -> 17:00:00 transition
  await tvWest.waitForFunction(() => document.documentElement.classList.contains('practice-mode'), null, { timeout: 16000 });
  await tvFull.waitForFunction(() => document.documentElement.classList.contains('practice-mode'), null, { timeout: 5000 });
  await sleep(600);

  const sw = await tvWest.evaluate(practiceState);
  const sf = await tvFull.evaluate(practiceState);
  check('/westcourt switches to practice mode (1920x1080) with header, 4 teams, both clocks, no coaches',
    sw.practiceMode && sw.status === 'practice' && /BASKETBALL PRACTICE.*5:00 PM/i.test(sw.title) &&
    sw.teams.length === 4 && /^\d{2}:\d{2}$/.test(sw.devo) && /^\d{2}:\d{2}$/.test(sw.end) && !sw.hasCoach && sw.idleHidden && !sw.clockLow,
    JSON.stringify({ title: sw.title, teams: sw.teams, devo: sw.devo, end: sw.end }));
  check('/fullcourt switches to practice mode (1366x768) with banner and both clocks',
    sf.practiceMode && sf.status === 'practice' && sf.teams.length === 4 && /^\d{2}:\d{2}$/.test(sf.devo) && /^\d{2}:\d{2}$/.test(sf.end),
    JSON.stringify({ devo: sf.devo, end: sf.end }));
  check('sound gate visible while locked and clear of practice clocks', sw.gateVisible && sw.sound === 'locked' && sw.gateClearsClocks);

  await shot(tvWest, 'r2-01-westcourt-1920x1080-locked.png');
  await shot(tvFull, 'r2-02-fullcourt-1366x768.png');

  // Split TV: both halves in practice mode
  const splitFrames = tvSplit.frames().filter((f) => f !== tvSplit.mainFrame());
  const splitStates = [];
  for (const f of splitFrames) {
    await f.waitForFunction(() => document.documentElement.classList.contains('practice-mode'), null, { timeout: 6000 });
    splitStates.push(await f.evaluate(practiceState));
  }
  check('/split both halves in practice mode with banner and both clocks',
    splitStates.length === 2 && splitStates.every((x) => x.practiceMode && x.teams.length === 4 && /^\d{2}:\d{2}$/.test(x.devo)),
    JSON.stringify(splitStates.map((x) => ({ devo: x.devo, end: x.end, teams: x.teams.length }))));
  await shot(tvSplit, 'r2-03-split-1920x1080.png');

  // Tap TV to unlock sound
  await tvWest.mouse.click(960, 540);
  await sleep(500);
  const swUnlocked = await tvWest.evaluate(practiceState);
  check('tapping TV hides sound gate (audio running)', !swUnlocked.gateVisible && swUnlocked.sound === 'on');

  // Admin: Practice clocks card, Pause -> PAUSED on TV, Resume, Restart
  const { page: adm } = await open(base, '/admin', DESK);
  if (await adm.locator('#login').isVisible()) {
    await adm.fill('#login input[type=password]', ADMIN);
    await adm.click('#login button');
    await sleep(1200);
  }
  await adm.waitForSelector('#practice-clock-wrap:not([hidden])', { timeout: 6000 });
  const admText = await adm.locator('#practice-clock-card').innerText();
  check('Admin shows Practice clocks card with slot, team count, and ticking clocks',
    /5:00 PM/i.test(admText) && /4 teams/i.test(admText) && /DEVO/i.test(admText) && /PRACTICE ENDS/i.test(admText),
    admText.replace(/\s+/g, ' ').slice(0, 120));
  await shot(adm, 'r2-04-admin-practice-clocks.png');

  // Pause
  await adm.click('button[data-practice-action="pause"]');
  await tvWest.waitForFunction(() => document.documentElement.classList.contains('practice-paused'), null, { timeout: 4000 });
  const paused1 = await tvWest.evaluate(practiceState);
  await sleep(1400);
  const paused2 = await tvWest.evaluate(practiceState);
  check('Admin Pause shows PAUSED on TV and freezes clocks',
    paused1.paused && paused2.paused && paused1.devo === paused2.devo && paused1.end === paused2.end,
    JSON.stringify({ t1: paused1.devo, t2: paused2.devo }));
  await shot(tvWest, 'r2-05-westcourt-paused.png');

  // Resume
  await adm.click('button[data-practice-action="resume"]');
  await tvWest.waitForFunction(() => !document.documentElement.classList.contains('practice-paused'), null, { timeout: 4000 });
  const res1 = await tvWest.evaluate(practiceState);
  await sleep(1500);
  const res2 = await tvWest.evaluate(practiceState);
  check('Admin Resume unpauses TV and clocks keep counting down', !res1.paused && !res2.paused && res2.devo !== res1.devo,
    JSON.stringify({ before: res1.devo, after: res2.devo }));

  // Restart (verify confirm dialog text and clocks reset near 25:00 / 60:00)
  await sleep(1200);
  let dialogMsg = '';
  adm.once('dialog', async (d) => { dialogMsg = d.message(); await d.accept(); });
  await adm.click('button[data-practice-action="restart"]');
  await tvWest.waitForFunction(() => {
    const t = document.querySelector('[data-practice-clock="devo"]')?.textContent?.trim() || '';
    return /^(25:00|24:5[5-9])$/.test(t);
  }, null, { timeout: 5000 }).catch(() => {});
  const admMsg = await adm.locator('#msg').innerText().catch(() => '');
  const afterRst = await tvWest.evaluate(practiceState);
  check('Admin Restart prompts confirm() and resets clocks to 25:00 / 60:00',
    /Restart both practice clocks for the 5:00 PM practice\?/i.test(dialogMsg) &&
    /^(25:00|24:5[5-9])$/.test(afterRst.devo) && /^(60:00|59:5[5-9])$/.test(afterRst.end),
    JSON.stringify({ dialog: dialogMsg, admMsg, devo: afterRst.devo, end: afterRst.end }));

  // Existing /practice/basketball and /practice/cheer still render unchanged
  const { page: pb } = await open(base, '/practice/basketball?day=mon&at=17:10', TV_1080);
  await sleep(700);
  check('/practice/basketball still renders', await pb.evaluate(() => /MONDAY/i.test(document.body.innerText) && !document.documentElement.classList.contains('practice-mode')));
  await shot(pb, 'r2-07-practice-basketball.png');

  const { page: pc } = await open(base, '/practice/cheer?day=mon&at=17:10', TV_1080);
  await sleep(700);
  check('/practice/cheer still renders', await pc.evaluate(() => /CHEER/i.test(document.body.innerText) && !document.documentElement.classList.contains('practice-mode')));
  await shot(pc, 'r2-08-practice-cheer.png');
}

async function runDevoFlow(base) {
  const { page: tvDevo } = await open(base, '/westcourt', TV_1080);
  await tvDevo.waitForFunction(() => document.documentElement.classList.contains('practice-mode'), null, { timeout: 6000 });
  // Unlock audio so buzzer logs sound: 'running'
  await tvDevo.mouse.click(960, 540);
  await sleep(300);

  // Wait up to 16 s for DEVO 0 buzz (5000 ms) + "Devo time!"
  await tvDevo.waitForFunction(() => (window.__buzzerLog || []).some((e) => e.ms === 5000), null, { timeout: 16000 });
  await sleep(400);
  const log = await tvDevo.evaluate(() => window.__buzzerLog || []);
  const st = await tvDevo.evaluate(practiceState);
  check('DEVO 0 triggers 5000 ms buzzer on TV and shows "Devo time!"',
    log.some((e) => e.ms === 5000 && e.sound === 'running') && st.devo === 'Devo time!',
    JSON.stringify({ log, devo: st.devo, end: st.end }));
  await shot(tvDevo, 'r2-06-westcourt-devo-time.png');
}

try {
  if (MODE === 'devo') {
    await runDevoFlow(BASE);
  } else if (MODE === 'slot') {
    await runSlotFlow(BASE);
  } else {
    await runSlotFlow(BASE);
    if (DEVO_BASE) await runDevoFlow(DEVO_BASE);
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => r.startsWith('FAIL')).length;
fs.writeFileSync(OUT + (MODE === 'devo' ? 'browser-checks-devo.txt' : 'browser-checks.txt'), results.join('\n') + '\n');
console.log(failed ? 'result: FAIL' : 'result: all passed');
if (failed) process.exit(1);
