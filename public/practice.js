// Practice TV (Mon–Thu): /upwardbasketballscores/practice/{cheer,basketball}. Polls /api/public/practice each minute,
// renders Sage's mockup markup (deliverables/mockups/practice) with its hooks, rotates pages per practice-view.js.
import { planPractice, rotation, parsePracticeDemo, practiceDisplayDay, ampm, COURTS, COURT_NAME, DAY, toMin } from './practice-view.js';
import { mascotHtml, installLogoFallback } from './logo-badge.js';
installLogoFallback(); // broken logo URL -> initial badge
import { nextEvent, nextEventText, addDays } from './next-event.js';

const kind = /\/practice\/cheer\/?$/.test(location.pathname) ? 'cheer' : 'basketball';
const qs = new URLSearchParams(location.search);
const demo = parsePracticeDemo(qs);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const body = document.body; body.classList.add(kind); body.dataset.kind = kind;
const loadedAt = Date.now();
// Setup footer: shows the route for the first minute (always with ?setup=1, never with ?setup=0).
$('[data-bind="route"]').textContent = location.pathname;
let data = null, offset = 0;
/** Only touch the DOM when the markup changed (renders each second; keeps logos from reloading). */
const setHtml = (el, html) => { if (el._html !== html) { el.innerHTML = html; el._html = html; } };

function fit() { const s = Math.min(innerWidth / 1920, innerHeight / 1080); body.style.setProperty('--scale', s);
  body.style.setProperty('--x', `${Math.max(0, (innerWidth - 1920 * s) / 2)}px`); body.style.setProperty('--y', `${Math.max(0, (innerHeight - 1080 * s) / 2)}px`); }
fit(); addEventListener('resize', fit);

let gameDays = [];
async function loadGames() { try { gameDays = (await (await fetch('/api/public/game-days')).json()).days || []; } catch {} }
async function load() { try { const r = await fetch('/api/public/practice'); data = await r.json(); offset = data.serverNow - Date.now(); } catch {} render(); }
function liveHm() {
  // league-local time from the server's last answer, advanced by local elapsed time (the date rolls on the next poll)
  const base = toMin(data.now.hm) + Math.floor((Date.now() + offset - data.serverNow) / 60000);
  return `${String(Math.floor(base / 60) % 24).padStart(2, '0')}:${String(base % 60).padStart(2, '0')}`;
}
/** Explicit ?day= wins. ?at= alone keeps today and the old window. Otherwise the next day that has this kind's slots. */
function viewClock() {
  if (demo) return { dow: demo.dow ?? data.now.dow, hm: demo.hm || liveHm(), mode: undefined };
  const disp = practiceDisplayDay(data, kind, data.now.date, data.now.dow);
  // Future weekday: preview (the clock time is ignored). Today: hold the schedule all day, including after the window.
  if (disp.over) return { dow: disp.dow, hm: liveHm(), mode: 'over' }; // past the season's last practice: idle
  if (!disp.today) return { dow: disp.dow, hm: liveHm(), mode: 'future' };
  return { dow: disp.dow, hm: liveHm(), mode: 'hold' };
}
const who = (name, coach, logo) => `${mascotHtml(logo, name)}<div class="team" data-bind="team">${esc(name)}</div><div class="coach" data-bind="coach">${coach ? `Coach ${esc(coach)}` : ''}</div>`;

function render() {
  if (!data) return;
  const { dow, hm, mode } = viewClock();
  const plan = planPractice(data, kind, dow, hm, mode);
  body.dataset.mode = plan.mode; body.dataset.day = plan.day;
  const setup = qs.get('setup'); $('[data-bind="route"]').hidden = setup === '0' || (setup !== '1' && Date.now() - loadedAt > 60000);
  const demoEl = $('[data-bind="demo"]'); demoEl.hidden = !demo; if (demo) demoEl.textContent = `DEMO · ${DAY[dow].toUpperCase()} ${ampm(hm)}`;
  const page = $('[data-bind="page"]'), main = $('main'), foot = $('[data-bind="footer"]');
  if (plan.mode === 'idle') {
    $('[data-bind="header"]').textContent = plan.header; page.hidden = true;
    main.className = 'idle'; main.removeAttribute('data-list');
    // Next event: practice night (this screen's kind) or game day, whichever is first. Demo day shifts the date.
    const today = data.now.date ? addDays(data.now.date, (dow - data.now.dow + 7) % 7) : null;
    const next = today ? nextEventText(nextEvent({ today, now: hm, gameDays, practice: data, kind }), today, !!data.range) : plan.next;
    setHtml(main, `<div class="idle-card"><div class="idle-title">No practice right now</div>${next ? `<div class="idle-next" data-bind="next">${esc(next)}</div>` : ''}</div>`);
    foot.textContent = ''; return;
  }
  const t = Math.floor((Date.now() - loadedAt) / 1000);
  if (kind === 'cheer') {
    const i = Math.floor(t / 12) % plan.pages.length;
    $('[data-bind="header"]').textContent = plan.header; page.hidden = false;
    setHtml(page, `ALL EVENING · <b>${i + 1} of ${plan.pages.length}</b>`);
    main.className = 'cheer-grid'; main.dataset.list = 'cheer'; main.dataset.page = String(i + 1);
    // Even cards = Cheer Primary, odd = Cheer Secondary (the slides alternate; .pink/.teal stay as CSS aliases).
    setHtml(main, plan.pages[i].map((x, k) => `<div class="card ${k % 2 ? 'secondary' : 'primary'}"><span class="room" data-bind="room">${esc(x.room)}</span>${who(x.squad.name, x.squad.coach, x.squad.logo)}</div>`).join(''));
    setHtml(foot, plan.startsText ? `<b>${esc(plan.startsText)}</b> · find your squad's room` : `Cheer practice: <b>find your squad's room</b> · Basketball on West &amp; East Courts`);
    return;
  }
  const r = rotation(plan, t), p = plan.pages[r.index];
  $('[data-bind="header"]').textContent = `${plan.header} ${ampm(p.time)}`; page.hidden = false;
  setHtml(page, `${ampm(p.time)} · <b>${r.index + 1} of ${plan.pages.length}</b><span class="dots">${plan.pages.map((_, k) => `<i${k === r.index ? ' class="on"' : ''}></i>`).join('')}</span>`);
  main.className = 'frame'; main.dataset.list = 'courts'; main.dataset.time = ampm(p.time); main.dataset.state = r.state;
  setHtml(main, COURTS.map((c) => { const x = p.courts[c];
    return x ? `<div class="court" data-court="${c}"><span class="label">${COURT_NAME[c]}</span>${who(x.team.name, x.team.coach, x.team.logo)}</div>`
      : `<div class="court" data-court="${c}" data-empty><span class="label">${COURT_NAME[c]}</span><div class="team" data-bind="team">Open</div></div>`; }).join(''));
  const nxt = plan.pages[r.index + 1];
  setHtml(foot, [plan.startsText && `<b>${esc(plan.startsText)}</b>`, r.state === 'next' ? 'Up next' : nxt ? `Up next: <b>${ampm(nxt.time)}</b>` : 'Last practice slot tonight', 'Cheer squads: see the cheer screen'].filter(Boolean).join(' · '));
}
loadGames().then(load); setInterval(load, 60000); setInterval(loadGames, 5 * 60000); setInterval(render, 1000);
