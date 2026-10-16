// Lobby schedule screen logic (no styling): fills the markup from server snapshots, sets state attributes,
// season colors and the paging offset. CSS (schedule.css, Sage) owns the look and the scroll animation.
import { connect, displayNow, clockMs, fmtClock, periodLabel } from './common.js';

const root = document.documentElement;
const qs = new URLSearchParams(location.search);
const query = new URLSearchParams();
for (const k of ['day', 'date']) if (qs.get(k)) query.set(k, qs.get(k));
const $ = (s) => document.querySelector(s);
const track = $('.sched-track'), view = $('.sched-view'), tpl = $('#tpl-game'), foot = $('.foot');
let snap = null;

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** "16:30" -> "4:30" (lobby style, like the mockup). */
const t12 = (hm) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`; };
const SPLIT = ['west', 'east'];

function setText(el, key, v) { const n = el.querySelector(`[data-bind="${key}"]`); if (n) n.textContent = v ?? ''; }

function gameEl(g, isNext) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const state = g.status === 'complete' ? 'complete' : g.status === 'active' ? 'active' : 'upcoming';
  el.dataset.state = state; el.dataset.gameId = g.id; el.dataset.court = g.court || '';
  if (g.court === 'full') el.dataset.span = 'full';
  if (isNext) el.dataset.next = 'true';
  el.dataset.swapped = String(!!g.swapped);
  for (const side of ['home', 'away']) { // season colors respecting swap: the chip wears its side's color
    const chip = el.querySelector(`.chip.${side}`), t = g[side];
    chip.dataset.wear = t.side; chip.style.setProperty('--team-color', t.color); chip.style.setProperty('--team-accent', t.accent);
  }
  const hs = g.home.score ?? 0, as = g.away.score ?? 0;
  if (state === 'complete') el.dataset.winner = hs > as ? 'home' : as > hs ? 'away' : 'tie';
  setText(el, 'time', t12(g.time));
  setText(el, 'grade-label', g.label || g.grade || '');
  setText(el, 'home-name', g.home.name); setText(el, 'away-name', g.away.name);
  if (state === 'upcoming') { const sc = el.querySelector('.score'); sc.className = 'score vs'; sc.textContent = 'vs'; }
  else { setText(el, 'home-score', hs); setText(el, 'away-score', as); }
  // Cheer squads: omit the .cheer div when there's none.
  // One squad per game: article.has-cheer + .cheer (logo src set and unhidden when present); no squad = no .cheer div.
  el.classList.toggle('has-cheer', !!g.cheer);
  if (!g.cheer) el.querySelector('.cheer').remove();
  else {
    setText(el, 'cheer', g.cheer.name);
    const im = el.querySelector('img[data-bind="cheer-logo"]');
    if (g.cheer.logo) { im.src = g.cheer.logo; im.hidden = false; }
  }
  setText(el, 'status-tag', state === 'complete' ? '✓ FINAL' : state === 'active' ? '● LIVE' : isNext ? '🕒 UP NEXT' : `🕒 ${t12(g.time)}`);
  setText(el, 'period', state === 'active' && g.period ? `Q${periodLabel(g.period, g.periods || 4)}`.replace('QOT', 'OT') : '');
  if (state !== 'active') el.querySelector('.pc').remove(); // period/clock only for active
  return el;
}
function slot(time, child) { const s = document.createElement('div'); s.className = 'slot'; s.dataset.time = time; if (child) s.appendChild(child); else s.dataset.empty = 'true'; return s; }

function render() {
  if (!snap) return;
  root.style.setProperty('--season-dark', snap.season.dark); root.style.setProperty('--season-light', snap.season.light);
  const dow = DOW[new Date(snap.date + 'T12:00:00Z').getUTCDay()];
  root.dataset.day = dow; root.dataset.date = snap.date;
  $('[data-bind="brand"]').textContent = snap.title || 'LBC Upward';
  $('[data-bind="church-name"]').textContent = snap.church?.name || '';
  $('[data-bind="day"]').textContent = snap.dayLabel;
  // "Up next": the first upcoming game per court (split courts and Full each).
  const nextIds = new Set();
  for (const c of new Set(snap.games.map((g) => g.court))) { const n = snap.games.find((g) => g.court === c && g.status === 'scheduled'); if (n) nextIds.add(n.id); }
  // Blocks in time order: runs of West/East games share one two-column block; Full Court games are full rows.
  const blocks = [];
  for (const g of snap.games) {
    const split = SPLIT.includes(g.court);
    const last = blocks[blocks.length - 1];
    if (split && last?.type === 'split') last.games.push(g); else blocks.push({ type: split ? 'split' : 'full', games: [g] });
  }
  track.textContent = '';
  for (const b of blocks) {
    if (b.type === 'full') {
      const row = document.createElement('div'); row.className = 'full-row';
      for (const g of b.games) row.appendChild(slot(g.time, gameEl(g, nextIds.has(g.id))));
      track.appendChild(row); continue;
    }
    const wrap = document.createElement('div'); wrap.className = 'split';
    const cols = Object.fromEntries(SPLIT.map((c) => { const s = document.createElement('section'); s.className = 'court-col'; s.dataset.court = c; wrap.appendChild(s); return [c, s]; }));
    for (const time of [...new Set(b.games.map((g) => g.time))]) { // one slot per time in both columns (empty keeps rows aligned)
      for (const c of SPLIT) { const g = b.games.find((x) => x.time === time && x.court === c); cols[c].appendChild(slot(time, g ? gameEl(g, nextIds.has(g.id)) : null)); }
    }
    track.appendChild(wrap);
  }
  $('.heads').hidden = !snap.games.some((g) => SPLIT.includes(g.court)); // omitted on Fridays (Full only)
  if (!snap.games.length) track.innerHTML = '<p class="empty">No games scheduled for this day.</p>';
  root.classList.toggle('has-active', snap.games.some((g) => g.status === 'active'));
  requestAnimationFrame(page);
}

/**
 * Fit one screen (schedule-structure.md): offset = top of the slot before the first non-complete game, clamped to
 * the track end. If the live + next games still don't fit, page through them every ~12 s. JS only sets --offset and
 * data-page (root + track); the CSS transition animates it (none under prefers-reduced-motion).
 */
const PAGE_MS = 12_000;
let pages = [0], pageIdx = 0, pageTimer = null;
const top = (el) => el.getBoundingClientRect().top - track.getBoundingClientRect().top; // independent of the current transform
function page() {
  const viewH = view.clientHeight, trackH = track.scrollHeight, maxOff = Math.max(0, trackH - viewH);
  pages = [0];
  if (maxOff > 0) {
    const games = [...track.querySelectorAll('.game')];
    const firstOpen = games.find((g) => g.dataset.state !== 'complete');
    let base = maxOff; // all final: show the end of the day
    if (firstOpen) {
      const s = firstOpen.closest('.slot'), allSlots = [...track.querySelectorAll('.slot')].filter((x) => top(x) < top(s) - 1);
      const prev = allSlots.sort((a, b) => top(b) - top(a))[0];
      base = Math.min(maxOff, Math.max(0, prev ? top(prev) : top(s)));
    }
    // Live + next games must be in view; if they reach past one screen, add pages until they're covered.
    const focus = games.filter((g) => g.dataset.state === 'active' || g.dataset.next === 'true');
    const bottom = Math.max(0, ...focus.map((g) => top(g) + g.offsetHeight));
    pages = [base];
    while (bottom > pages[pages.length - 1] + viewH && pages[pages.length - 1] < maxOff) pages.push(Math.min(maxOff, pages[pages.length - 1] + viewH));
    const earlier = games.filter((g) => g.dataset.state === 'complete' && top(g) + g.offsetHeight <= base).length;
    $('[data-bind="earlier"]').textContent = earlier ? `▲ ${earlier} earlier final${earlier === 1 ? '' : 's'}` : '';
  } else $('[data-bind="earlier"]').textContent = '';
  if (pageIdx >= pages.length) pageIdx = 0;
  applyPage();
  clearInterval(pageTimer); pageTimer = pages.length > 1 ? setInterval(() => { pageIdx = (pageIdx + 1) % pages.length; applyPage(); }, PAGE_MS) : null;
}
function applyPage() {
  const off = pages[pageIdx] || 0;
  for (const el of [root, track]) { el.style.setProperty('--offset', `${-off}px`); el.dataset.page = String(pageIdx); }
  root.style.setProperty('--page', `${-off}px`); root.dataset.pages = String(pages.length);
  root.classList.toggle('overflows', track.scrollHeight > view.clientHeight);
  foot.innerHTML = pages.length > 1 ? pages.map((_, i) => `<i class="${i === pageIdx ? 'on' : ''}"></i>`).join('') : '';
}
addEventListener('resize', () => requestAnimationFrame(page));

const CONN_TEXT = { online: '● Live', connecting: 'Connecting…', offline: 'Offline · reconnecting' };
const conn = connect({
  court: '*', role: 'schedule', query: query.toString(),
  onState: (m) => { if (m.kind === 'schedule') { snap = m; render(); } },
  onStatus: (st) => { root.dataset.conn = st; $('[data-bind="connText"]').textContent = CONN_TEXT[st] || st; },
});
root.dataset.conn = 'connecting'; $('[data-bind="connText"]').textContent = CONN_TEXT.connecting;

// Live clocks on active games, from server time (frozen while offline, like the TV).
function tick() {
  if (snap) for (const el of document.querySelectorAll('.game[data-state="active"] [data-bind="clock"]')) {
    const g = snap.games.find((x) => String(x.id) === el.closest('.game').dataset.gameId);
    if (g?.clock) { const t = fmtClock(clockMs(g.clock, displayNow(conn))); if (el.textContent !== t) el.textContent = t; }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
