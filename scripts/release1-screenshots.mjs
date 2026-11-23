// Release 1 screenshots + browser checks (headless Chrome). Run against a LOCAL scratch server only, e.g. the one
// scripts/run-e2e.sh starts, or: seed-demo on a scratch DB + server with SCOREBOARD_TEST_NOW on a Saturday 10:00.
// Usage: BASE_URL=http://localhost:18620 OUT=/path/to/screens CHROME_PATH=/usr/bin/google-chrome node scripts/release1-screenshots.mjs
// It starts/loads games on the server it is pointed at, so never point it at the live site.
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:18620';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('local scratch server only');
const OUT = (process.env.OUT || new URL('../release1-screens/', import.meta.url).pathname).replace(/\/?$/, '/');
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
const PIN = { full: '1111', west: '2222', east: '3333' };
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' · ' + extra : ''}`); console.log(results.at(-1)); };

const token = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) })).json()).token;
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = async (p, o = {}) => (await fetch(BASE + p, { ...o, headers: H })).json();
let games = await api('/api/games');
for (const g of games.filter((g) => g.status === 'active')) await api(`/api/games/${g.id}/complete`, { method: 'POST' });
games = await api('/api/games');
const fullG = games.find((g) => g.court_slug === 'full' && g.full_court && g.status === 'scheduled');
const westG = games.find((g) => g.court_slug === 'west' && !g.full_court && /3rd-4th/.test(g.grade) && g.status === 'scheduled');
const cmds = async (court, list) => {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?court=${court}&role=score`, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((r) => ws.on('open', r)); await sleep(150);
  for (const cmd of list) { ws.send(JSON.stringify({ type: 'cmd', id: Math.random().toString(36).slice(2), cmd })); await sleep(60); }
  await sleep(300); ws.close();
};
await api(`/api/games/${fullG.id}/start`, { method: 'POST', body: '{}' });
await cmds('full', [{ type: 'SCORE', team: 'home', pts: 2 }, { type: 'SCORE', team: 'away', pts: 3 }, { type: 'SCORE', team: 'home', pts: 2 }, { type: 'POSSESSION', team: 'home' }]);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=user-gesture-required'] });
// Headless Chrome does not enforce the autoplay rule (AudioContext starts "running"), so emulate a real TV browser:
// audio stays suspended until the first tap/click on the page. buzzer.js itself is unchanged.
const AUTOPLAY_LOCK = `(() => { const R = window.AudioContext; if (!R) return; let g = false;
  for (const ev of ['pointerdown', 'touchstart', 'keydown']) window.addEventListener(ev, () => { g = true; }, { capture: true });
  window.AudioContext = class extends R { get state() { return g ? super.state : 'suspended'; } resume() { return g ? super.resume() : Promise.resolve(); } }; })();`;
const ctxOf = async (viewport) => { const c = await browser.newContext({ viewport, deviceScaleFactor: 1 }); await c.addInitScript(AUTOPLAY_LOCK); return c; };
const TV = { width: 1920, height: 1080 }, PHONE = { width: 430, height: 932 }, DESK = { width: 1366, height: 1000 };
const titles = [];
async function open(url, viewport) { const ctx = await ctxOf(viewport); const page = await ctx.newPage(); await page.goto(BASE + url); await sleep(1200); titles.push([url, await page.title()]); return page; }
async function scoreSignIn(page, court) {
  if (await page.locator('#pin-gate').isVisible()) { await page.fill('#pin', PIN[court]); await page.click('#pin-gate button'); await sleep(900); }
  if (await page.locator('#resume-ok').isVisible()) { await page.click('#resume-ok'); await sleep(500); }
}
const shot = (page, f, full = false) => page.screenshot({ path: OUT + f, fullPage: full });

// --- Court TV (full court): sound gate first, then tap, then normal
const tvFull = await open('/fullcourt', TV);
check('court TV shows "Tap to enable sound" while audio is locked', await tvFull.locator('#sound-gate').isVisible());
await shot(tvFull, '07-court-tv-enable-sound-overlay.png');
await tvFull.mouse.click(960, 540); await sleep(600);
check('one tap hides the sound gate (audio running)', !(await tvFull.locator('#sound-gate').isVisible()) && (await tvFull.evaluate(() => document.documentElement.dataset.sound)) === 'on');
check('full court TV shows timeouts, no fouls/bonus', await tvFull.evaluate(() => document.documentElement.classList.contains('full-court') && !document.body.innerText.includes('FOULS') && !document.body.innerText.includes('BONUS')));
await shot(tvFull, '05-court-tv-full-court-normal.png');

// --- Score screen, full court: timeouts + buzzer button
const scFull = await open('/score/full', PHONE); await scoreSignIn(scFull, 'full');
check('score screen (full court): Buzzer + 2 Timeout buttons visible, no foul buttons', await scFull.evaluate(() =>
  !document.getElementById('buzzer').hidden && [...document.querySelectorAll('.btn.timeout')].filter((b) => !b.hidden).length === 2 && !document.body.innerText.includes('Foul')));
await shot(scFull, '01-score-full-court-timeouts-buzzer.png', true);
// manual buzzer -> plays on the full court TV
const before = await tvFull.evaluate(() => (window.__buzzerLog || []).length);
await scFull.click('#buzzer'); await sleep(700);
const log1 = await tvFull.evaluate(() => window.__buzzerLog || []);
check('manual buzzer on the score screen plays 3 s on that court TV', log1.length === before + 1 && log1.at(-1).ms === 3000 && log1.at(-1).sound === 'running');
// red clock at 1:00 or less (score + TV)
await cmds('full', [{ type: 'CLOCK_SET', ms: 45_000 }]); await sleep(500);
check('score clock red at 0:45', await scFull.evaluate(() => document.querySelector('[data-clock]').dataset.low === 'true' && getComputedStyle(document.querySelector('[data-clock]')).color === 'rgb(255, 77, 66)'));
check('TV clock red at 0:45', await tvFull.evaluate(() => document.documentElement.classList.contains('clock-low') && getComputedStyle(document.querySelector('.clock')).color === 'rgb(255, 77, 66)'));
await shot(scFull, '03-score-red-clock.png', true);
await shot(tvFull, '06-court-tv-red-clock.png');
await cmds('full', [{ type: 'CLOCK_SET', ms: 61_000 }]); await sleep(400);
check('clock white above 1:00', await tvFull.evaluate(() => !document.documentElement.classList.contains('clock-low')));
// auto-advance at halftime + auto buzzer
await cmds('full', [{ type: 'PERIOD', delta: 1 }, { type: 'PERIOD', delta: 1 }, { type: 'CLOCK_SET', ms: 1500 }, { type: 'CLOCK_START' }]);
await sleep(2300);
const log2 = await tvFull.evaluate(() => window.__buzzerLog || []);
check('auto buzzer at 0 (end of P3) on the court TV', log2.length === log1.length + 1 && log2.at(-1).sound === 'running');
const halftime = await scFull.evaluate(() => ({ per: document.querySelector('[data-bind="period"]').textContent, start: document.getElementById('clock-toggle').disabled, clock: document.querySelector('[data-clock]').textContent }));
check('auto-advance to 2nd Half · P4, clock 06:00 stopped, START enabled', halftime.per === '2nd Half · P4' && !halftime.start && halftime.clock === '06:00', JSON.stringify(halftime));
await shot(scFull, '04-score-halftime-auto-advanced.png', true);
await shot(tvFull, '08-court-tv-halftime.png');
await scFull.click('#clock-toggle'); await sleep(600);
check('START works at halftime (no Prev/Next)', await scFull.evaluate(() => document.getElementById('clock-toggle').textContent.includes('STOP')));
// end-game prompt after the final period
await cmds('full', [{ type: 'CLOCK_STOP' }, { type: 'PERIOD', delta: 1 }, { type: 'PERIOD', delta: 1 }, { type: 'CLOCK_SET', ms: 1200 }, { type: 'CLOCK_START' }]);
await sleep(2200);
const dlg = await scFull.evaluate(() => ({ open: document.getElementById('confirm-dialog').open, text: document.getElementById('confirm-text').textContent, ok: document.getElementById('confirm-ok').textContent, kind: document.getElementById('confirm-dialog').dataset.kind, kicker: getComputedStyle(document.querySelector('#confirm-dialog form'), '::before').content }));
check('"Ready to end the game?" after the final period', dlg.open && dlg.text === 'Ready to end the game?' && dlg.ok === 'End game', JSON.stringify(dlg));
await shot(scFull, '02-score-end-game-prompt.png', true);
await scFull.click('#confirm-cancel'); await sleep(500);
const stays = await api(`/api/public/court/full`);
check('Cancel keeps the game active', stays.game?.state.status === 'active' && stays.game.state.period === 6);

// --- Admin: buzzer button on the Full court card
const adm = await open('/admin', DESK);
if (await adm.locator('#login').isVisible()) { await adm.fill('#login input[type=password]', ADMIN); await adm.click('#login button'); await sleep(1500); }
check('Admin: Buzzer button on the full court card', await adm.locator('button[data-buzzer]').count() === 1);
await adm.locator('button[data-buzzer]').scrollIntoViewIfNeeded();
await shot(adm, '10-admin-buzzer-button.png');
const b3 = await tvFull.evaluate(() => (window.__buzzerLog || []).length);
await adm.click('button[data-buzzer]'); await sleep(700);
check('Admin buzzer plays on the full court TV', (await tvFull.evaluate(() => (window.__buzzerLog || []).length)) === b3 + 1);
// End game via the prompt's confirm path: reload score (new period key) -> use Complete instead is covered by tests; here confirm a fresh prompt
await scFull.evaluate(() => { for (const k of Object.keys(sessionStorage)) sessionStorage.removeItem(k); });
await scFull.reload(); await sleep(1200); await scoreSignIn(scFull, 'full'); await sleep(800);
if (await scFull.evaluate(() => document.getElementById('confirm-dialog').open)) { await scFull.click('#confirm-ok'); await sleep(800); }
const done = await api(`/api/games/${fullG.id}/events`);
check('Confirm on "Ready to end the game?" completes the game', Array.isArray(done) && done.some((e) => (e.command?.type || JSON.parse(e.command || '{}').type) === 'END_GAME'));

// --- Non-full-court game on West
await api(`/api/games/${westG.id}/start`, { method: 'POST', body: JSON.stringify({ force: true }) });
await cmds('west', [{ type: 'SCORE', team: 'home', pts: 2 }, { type: 'SCORE', team: 'away', pts: 2 }, { type: 'SCORE', team: 'away', pts: 1 }]);
const scWest = await open('/score/west', PHONE); await scoreSignIn(scWest, 'west');
check('score screen (half court): no timeouts, no fouls, no buzzer', await scWest.evaluate(() =>
  document.getElementById('buzzer').hidden && [...document.querySelectorAll('.btn.timeout')].every((b) => b.hidden) && !document.body.innerText.includes('Foul')));
await shot(scWest, '09-score-non-full-court.png', true);
const tvWest = await open('/westcourt', TV); await tvWest.mouse.click(960, 540); await sleep(400);
check('half court TV: no timeouts/fouls row', await tvWest.evaluate(() => !document.documentElement.classList.contains('full-court')));
await shot(tvWest, '05b-court-tv-west-normal.png');
const legacy = await open('/upwardbasketballscores/westcourt', TV);
check('legacy /upwardbasketballscores/westcourt still renders West', await legacy.evaluate(() => document.body.innerText.includes('West')));

// --- Lobby + practice + split
const lobby = await open('/lobby', TV); await sleep(800);
check('lobby: no sound gate, branded', await lobby.evaluate(() => !document.getElementById('sound-gate') && document.body.innerText.includes('UPWARD BASKETBALL AND CHEER')));
await shot(lobby, '11-lobby.png');
const pb = await open('/practice/basketball?day=mon&at=17:30', TV); await sleep(800);
check('practice basketball at 5:30 PM shows the 6:00 PM practice', await pb.evaluate(() => /6:00 PM/.test(document.querySelector('[data-bind="header"]').textContent)), await pb.evaluate(() => document.querySelector('[data-bind="header"]').textContent));
await shot(pb, '12-practice-basketball-530pm.png');
const pb2 = await open('/practice/basketball?day=mon&at=17:29', TV); await sleep(800);
await shot(pb2, '12b-practice-basketball-529pm.png');
const pc = await open('/practice/cheer?day=mon&at=17:30', TV); await sleep(800);
await shot(pc, '13-practice-cheer.png');
const sp = await open('/split', TV); await sleep(800);
await shot(sp, '14-split-tv.png');
for (const u of ['/', '/score/east', '/fullcourt/overlay', '/admin/practice', '/upwardbasketballscores/lobby', '/upwardbasketballscores/practice/cheer']) await open(u, DESK);

// --- Tab titles page
const tt = await (await ctxOf({ width: 1100, height: 760 })).newPage();
await tt.setContent(`<html><body style="font:16px system-ui;padding:20px;background:#fff"><h2>Browser tab titles (Release 1)</h2><table border=1 cellpadding=6 style="border-collapse:collapse">${titles.map(([u, t]) => `<tr><td><code>${u}</code></td><td>${t}</td></tr>`).join('')}</table></body></html>`);
await tt.screenshot({ path: OUT + '15-tab-titles.png', fullPage: true });
check('every page title says "Upward Basketball and Cheer"', titles.every(([, t]) => t.includes('Upward Basketball and Cheer')), titles.filter(([, t]) => !t.includes('Upward Basketball and Cheer')).map(([u]) => u).join(','));
fs.writeFileSync(OUT + 'tab-titles.txt', titles.map(([u, t]) => `${u}\t${t}`).join('\n') + '\n');
fs.writeFileSync(OUT + 'browser-checks.txt', results.join('\n') + '\n');
await browser.close();
for (const g of (await api('/api/games')).filter((g) => g.status === 'active')) await api(`/api/games/${g.id}/complete`, { method: 'POST' });
console.log(results.filter((r) => r.startsWith('FAIL')).length ? 'result: FAIL' : 'result: all passed');
