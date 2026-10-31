// Lobby fit scan (QA R29): for each ?date&at and viewport, measure (in 1920x1080 stage px) the lowest bottom of any
// element in <main> and report slack = 1080 - bottom (negative = cut off), the density step, and clipped names.
// usage: BASE_URL=http://localhost:3000 CHROME_PATH=/usr/bin/google-chrome node scripts/lobby-fit-scan.mjs [--json]
// Env: FIT_DATES (default 2027-01-15,2027-01-16), FIT_TIMES (default every :05 and :35 from 08:05 to 20:35),
//      FIT_VIEWPORTS (default 1920x1080,1366x768).
import { chromium } from 'playwright-core';

export async function measure(page) {
  return page.evaluate(() => {
    const body = document.body, br = body.getBoundingClientRect();
    const k = br.height / 1080; // body = the 1920x1080 stage, uniformly scaled
    let bottom = 0, right = 0;
    for (const el of document.querySelectorAll('main *')) {
      const r = el.getBoundingClientRect(); if (!r.height) continue;
      bottom = Math.max(bottom, (r.bottom - br.top) / k); right = Math.max(right, (r.right - br.left) / k);
    }
    const clipped = [...document.querySelectorAll('main .who .name')].filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent);
    return { bottom: Math.round(bottom), slack: Math.round(1080 - bottom), right: Math.round(right), clipped,
      density: document.documentElement.dataset.density || 'normal', scaled: document.documentElement.style.getPropertyValue('--fit-k') || null,
      empty: document.documentElement.dataset.empty === 'true', rows: document.querySelectorAll('main [data-row]').length };
  });
}
export async function open(page, base, date, at) {
  await page.goto(`${base}/lobby?date=${date}&at=${at}`);
  await page.waitForFunction(() => document.documentElement.dataset.empty !== undefined && document.fonts.status === 'loaded', null, { timeout: 15000 });
  await page.waitForTimeout(300);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.BASE_URL || 'http://localhost:3000';
  const dates = (process.env.FIT_DATES || '2027-01-15,2027-01-16').split(',');
  const times = process.env.FIT_TIMES ? process.env.FIT_TIMES.split(',') : Array.from({ length: 13 }, (_, i) => i + 8).flatMap((h) => [`${String(h).padStart(2, '0')}:05`, `${String(h).padStart(2, '0')}:35`]);
  const vps = (process.env.FIT_VIEWPORTS || '1920x1080,1366x768').split(',').map((s) => s.split('x').map(Number));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const out = [];
  for (const [w, h] of vps) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    for (const date of dates) for (const at of times) {
      await open(page, base, date, at);
      const m = await measure(page);
      if (!m.empty) out.push({ vp: `${w}x${h}`, date, at, ...m });
    }
    await page.close();
  }
  await browser.close();
  if (process.argv.includes('--json')) console.log(JSON.stringify(out));
  else for (const r of out) console.log(`${r.vp} ${r.date} ${r.at} slack=${r.slack} density=${r.density}${r.scaled ? ' k=' + r.scaled : ''} rows=${r.rows}${r.clipped.length ? ' CLIPPED=' + r.clipped.join('|') : ''}`);
  const worst = out.reduce((a, b) => (b.slack < a.slack ? b : a), out[0]);
  console.log(`worst: ${worst.vp} ${worst.date} ${worst.at} slack=${worst.slack}; clipped names: ${out.filter((r) => r.clipped.length).length}; overflow: ${out.filter((r) => r.slack < 0).length}`);
}
