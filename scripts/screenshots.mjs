// Capture TV / overlay / controller / admin screenshots with a headless Chrome, setting up real state
// first (seed teams: West+East block, then Full with cheer squads). Writes docs/screenshots and copies to
// deliverables/screenshots. Leaves no game active afterwards.
// Usage: CHROME_PATH=/usr/bin/google-chrome node scripts/screenshots.mjs
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
const DELIV = new URL('../deliverables/screenshots/', import.meta.url).pathname;
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
const PINS = { full: process.env.PINF || '1111', west: process.env.PIN1 || '2222', east: process.env.PIN2 || '3333' };
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(DELIV, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token;
for (let i = 0; i < 3 && !token; i++) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN }) });
  if (r.status === 429) { await sleep(Number(r.headers.get('retry-after') || 5) * 1000 + 300); continue; }
  token = (await r.json()).token;
}
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = async (p, o = {}) => (await fetch(BASE + p, { ...o, headers: H })).json();
const games = await api('/api/games');
for (const g of games.filter((g) => g.status === 'active')) await api(`/api/games/${g.id}/complete`, { method: 'POST' });
const find = (h, a) => games.find((g) => g.home === h && g.away === a && g.status === 'scheduled');
const cmds = async (court, list) => {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?court=${court}&role=score`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'auth', token })); await sleep(200);
  for (const cmd of list) { ws.send(JSON.stringify({ type: 'cmd', id: Math.random().toString(36).slice(2), cmd })); await sleep(40); }
  await sleep(300); ws.close();
};
const play = (h, a, extra = []) => [...Array(h).fill({ type: 'SCORE', team: 'home', pts: 2 }), ...Array(a).fill({ type: 'SCORE', team: 'away', pts: 2 }),
  { type: 'FOUL', team: 'home', delta: 1 }, { type: 'FOUL', team: 'away', delta: 1 }, { type: 'POSSESSION', team: 'home' }, ...extra];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const shot = async (url, file, viewport, prep) => {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(BASE + url);
  if (prep) await prep(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + file, omitBackground: file.includes('overlay') });
  fs.copyFileSync(OUT + file, DELIV + file);
  console.log(OUT + file);
  await ctx.close();
};
const pin = (court) => async (p) => { await p.fill('#pin', PINS[court]); await p.click('#pin-gate button'); await p.waitForSelector('#app:not([hidden])'); };
const admin = async (p) => { await p.fill('#password', ADMIN); await p.click('#login button'); await p.waitForSelector('#app:not([hidden])'); };

// 1. Idle TV + scorekeeper picker (nothing active)
await shot('/upwardbasketballscores/westcourt', 'tv-idle-next-up.png', { width: 1920, height: 1080 });
await shot('/score/full', 'controller-picker.png', { width: 390, height: 844 }, pin('full'));
// 2. West + East block
const w = find('Bears', 'Dolphins'), e = find('Hawks', 'Tigers');
await api(`/api/games/${w.id}/start`, { method: 'POST' }); await api(`/api/games/${e.id}/start`, { method: 'POST' });
await cmds('west', play(9, 7)); await cmds('east', play(6, 8, [{ type: 'CLOCK_SET', ms: 4 * 60_000 + 12_000 }]));
await shot('/upwardbasketballscores/westcourt', 'tv-west.png', { width: 1920, height: 1080 });
await shot('/upwardbasketballscores/eastcourt', 'tv-east.png', { width: 1920, height: 1080 });
await shot('/tv/split', 'tv-split.png', { width: 1920, height: 1080 });
await shot('/upwardbasketballscores/westcourt/overlay', 'overlay-west.png', { width: 1920, height: 1080 });
await shot('/score/west', 'controller-phone.png', { width: 390, height: 1400 }, async (p) => { await pin('west')(p); await p.click('#resume-ok'); });
await shot('/score/west', 'controller-tablet.png', { width: 1180, height: 820 }, async (p) => { await pin('west')(p); await p.click('#resume-ok'); });
await shot('/admin', 'admin-today.png', { width: 1280, height: 900 }, admin);
await shot('/admin#teams', 'admin-season-teams.png', { width: 1280, height: 1100 }, admin);
await shot('/admin#courts', 'admin-qr.png', { width: 1280, height: 1400 }, async (p) => { await admin(p); await p.click('#qr-show'); await p.waitForSelector('.qr-card'); });
await shot('/admin#schedule', 'admin-schedule.png', { width: 1280, height: 1200 }, admin);
await api(`/api/games/${w.id}/complete`, { method: 'POST' }); await api(`/api/games/${e.id}/complete`, { method: 'POST' });
// 3. Full block with cheer squads (Eagles Cheer / Lions Cheer)
const f = find('Eagles', 'Lions');
await api(`/api/games/${f.id}/start`, { method: 'POST' });
await cmds('full', play(14, 12, [{ type: 'PERIOD', delta: 1 }]));
await shot('/upwardbasketballscores/fullcourt', 'tv-full-cheer.png', { width: 1920, height: 1080 });
await api(`/api/games/${f.id}/complete`, { method: 'POST' });
await browser.close();
for (const old of ['tv-court-1.png', 'tv-court-2.png', 'overlay-court-1.png']) for (const d of [OUT, DELIV]) fs.rmSync(d + old, { force: true });
