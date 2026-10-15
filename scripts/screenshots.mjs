// Capture TV / overlay / controller / admin screenshots with a headless Chrome.
// Usage: CHROME_PATH=/usr/bin/google-chrome node scripts/screenshots.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
const PIN1 = process.env.PIN1 || '1111';
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me-admin';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const shot = async (url, file, viewport, prep) => {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(BASE + url);
  if (prep) await prep(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + file, omitBackground: file.includes('overlay') });
  console.log(OUT + file);
  await ctx.close();
};
const pin = async (p) => { await p.fill('#pin', PIN1); await p.click('#pin-gate button'); await p.waitForSelector('#app:not([hidden])'); };
await shot('/tv/court-1', 'tv-court-1.png', { width: 1920, height: 1080 });
await shot('/tv/court-2', 'tv-court-2.png', { width: 1920, height: 1080 });
await shot('/overlay/court-1', 'overlay-court-1.png', { width: 1920, height: 1080 });
await shot('/score/court-1', 'controller-tablet.png', { width: 1180, height: 820 }, pin);
await shot('/score/court-1', 'controller-phone.png', { width: 390, height: 1400 }, pin);
await shot('/admin', 'admin-today.png', { width: 1280, height: 900 }, async (p) => { await p.fill('#password', ADMIN); await p.click('#login button'); await p.waitForSelector('#app:not([hidden])'); });
await browser.close();
