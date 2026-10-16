// Lobby schedule screen logic (no styling): fills the markup from server snapshots, sets state attributes,
// season colors and the paging offset. CSS (schedule.css, Sage) owns the look and the scroll animation.
import { connect, displayNow, clockMs, fmtClock, periodLabel } from './common.js';
import { t12, winnerOf, statusTag, emptyText, planSchedule, blocksOf, collapseFinals, earlierText, pageOffsets, rowCount } from './schedule-view.js';

const root = document.documentElement;
const qs = new URLSearchParams(location.search);
const query = new URLSearchParams();
for (const k of ['day', 'date']) if (qs.get(k)) query.set(k, qs.get(k));
const $ = (s) => document.querySelector(s);
const track = $('.sched-track'), view = $('.sched-view'), pinned = $('.sched-pinned'), earlierEl = $('.earlier'), tpl = $('#tpl-game'), foot = $('.foot');
let snap = null;

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SPLIT = ['west', 'east'];

function setText(el, key, v) { const n = el.querySelector(`[data-bind="${key}"]`); if (n) n.textContent = v ?? ''; }

function gameEl(g, isNext, compact) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const state = g.status === 'complete' ? 'complete' : g.status === 'active' ? 'active' : 'upcoming';
  el.dataset.state = state; el.dataset.gameId = g.id; el.dataset.court = g.court || '';
  if (g.court === 'full') el.dataset.span = 'full';
  if (isNext) el.dataset.next = 'true';
  if (compact) el.dataset.compact = 'true'; // a final shown in the leftover space
  el.dataset.swapped = String(!!g.swapped);
  for (const side of ['home', 'away']) { // season colors respecting swap: the chip wears its side's color
    const chip = el.querySelector(`.chip.${side}`), t = g[side];
    chip.dataset.wear = t.side; chip.style.setProperty('--team-color', t.color); chip.style.setProperty('--team-accent', t.accent);
    // Readable text on the chip, computed like the TV (Sage's contrast.js): --team-fg = #fff or #111.
    if (window.Contrast) chip.style.setProperty('--team-fg', window.Contrast.bestText(t.color));
  }
  const hs = g.home.score ?? 0, as = g.away.score ?? 0;
  const winner = winnerOf(g.status, hs, as);
  if (winner) el.dataset.winner = winner;
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
  setText(el, 'status-tag', statusTag(state, winner, isNext, g.time));
  setText(el, 'period', state === 'active' && g.period ? `Q${periodLabel(g.period, g.periods || 4)}`.replace('QOT', 'OT') : '');
  if (state !== 'active') el.querySelector('.pc').remove(); // period/clock only for active
  return el;
}
function slot(time, child) { const s = document.createElement('div'); s.className = 'slot'; s.dataset.time = time; if (child) s.appendChild(child); else s.dataset.empty = 'true'; return s; }

/** Blocks -> DOM: West/East runs share one .split (two .court-col, one aligned .slot per time); Full rows span both. */
function buildBlocks(games, nextIds, compact = false, pinnedMode = false) {
  const frag = document.createDocumentFragment();
  for (const b of blocksOf(games)) {
    if (b.type === 'full') {
      const row = document.createElement('div'); row.className = 'full-row';
      row.appendChild(slot(b.game.time, gameEl(b.game, nextIds.has(b.game.id), compact))); frag.appendChild(row); continue;
    }
    const wrap = document.createElement('div'); wrap.className = 'split';
    for (const c of SPLIT) {
      const col = document.createElement('section'); col.className = 'court-col'; col.dataset.court = c;
      // Pinned: only real games (no data-empty placeholders); each court lists its live + next top-aligned.
      for (const r of b.rows) if (r[c] || !pinnedMode) col.appendChild(slot(r.time, r[c] ? gameEl(r[c], nextIds.has(r[c].id), compact) : null));
      wrap.appendChild(col);
    }
    frag.appendChild(wrap);
  }
  return frag;
}

let plan = null;
function render() {
  if (!snap) return;
  root.style.setProperty('--season-dark', snap.season.dark); root.style.setProperty('--season-light', snap.season.light);
  const dow = DOW[new Date(snap.date + 'T12:00:00Z').getUTCDay()];
  root.dataset.day = dow; root.dataset.date = snap.date;
  $('[data-bind="brand"]').textContent = snap.title || 'LBC Upward';
  $('[data-bind="church-name"]').textContent = snap.church?.name || '';
  $('[data-bind="day"]').textContent = snap.dayLabel;
  // Paging rule (schedule-view.js): live + UP NEXT pinned (never moved), later upcoming in the track (paged if they
  // overflow), finals last and only in the leftover space (most recent first to stay, the rest "▲ N earlier finals").
  plan = planSchedule(snap.games);
  if (plan.phase) root.dataset.phase = plan.phase; else delete root.dataset.phase;
  pinned.replaceChildren(buildBlocks(plan.pinned, plan.nextIds, false, true));
  pinned.hidden = !plan.pinned.length;
  $('.heads').hidden = !snap.games.some((g) => SPLIT.includes(g.court)); // omitted on Fridays (Full only)
  // Empty day: hide the court heads, show .empty (outside the track, so paging can't move it).
  const empty = $('.empty'), none = !snap.games.length;
  empty.hidden = !none; empty.textContent = none ? emptyText(!!snap.isToday, snap.dayLabel) : '';
  if (none) $('.heads').hidden = true;
  root.classList.toggle('no-games', none);
  root.classList.toggle('has-active', snap.games.some((g) => g.status === 'active'));
  requestAnimationFrame(layout);
}

/**
 * Fill the track: later upcoming first, then the most recent finals (data-compact) in the leftover space, i.e. what
 * remains of the frame after pinned + upcoming; when the upcoming games page, that's the room left on their last
 * page, so finals never add a page and never push an upcoming game. The rest collapse into "▲ N earlier finals".
 */
function layout() {
  if (!plan) return;
  const viewH = view.clientHeight;
  const fill = (rows) => {
    const r = collapseFinals(plan.finals, rows);
    track.replaceChildren(buildBlocks(plan.later, plan.nextIds));
    earlierEl.textContent = earlierText(r.earlier);
    track.appendChild(earlierEl); // the "▲ N earlier finals" line sits just above the finals that are shown
    if (r.shown.length) track.appendChild(buildBlocks(r.shown, plan.nextIds, true));
    return r;
  };
  fill(0);
  const base = computePages(viewH), lastEnd = base[base.length - 1] + viewH; // pages of the upcoming games alone
  const units = rowCount(plan.finals);
  let rows = units, r;
  for (;;) { // largest number of final rows that fits on the last page without changing the upcoming pages
    r = fill(rows);
    if (!rows || (track.scrollHeight <= lastEnd + 0.5 && computePages(viewH).length === base.length)) break;
    rows--;
  }
  page();
}

/**
 * Rotation applies only to .sched-track (later upcoming slots). Pages break at row tops; with no overflow there's
 * one page (data-pages=1, no dots). JS only sets --offset and data-page (root + track); CSS animates it.
 */
const PAGE_MS = 12_000;
let pages = [0], pageIdx = 0, pageTimer = null;
const top = (el) => el.getBoundingClientRect().top - track.getBoundingClientRect().top; // independent of the current transform
function computePages(viewH) {
  const rowEls = [...track.querySelectorAll('.full-row, .court-col[data-court="west"] > .slot, .earlier')].filter((e) => e.offsetHeight);
  rowEls.sort((a, b) => top(a) - top(b));
  return pageOffsets(rowEls.map(top), rowEls.map((e) => top(e) + e.offsetHeight), viewH);
}
function page() {
  pages = computePages(view.clientHeight);
  track.dataset.offsets = pages.join(','); // page tops in px (for tests; CSS uses --offset)
  if (pageIdx >= pages.length) pageIdx = 0;
  applyPage();
  clearInterval(pageTimer); pageTimer = pages.length > 1 ? setInterval(() => { pageIdx = (pageIdx + 1) % pages.length; applyPage(); }, PAGE_MS) : null;
}
function applyPage() {
  const off = pages[pageIdx] || 0;
  for (const el of [root, track]) { el.style.setProperty('--offset', `${-off}px`); el.dataset.page = String(pageIdx); }
  root.style.setProperty('--page', `${-off}px`); root.dataset.pages = String(pages.length);
  root.classList.toggle('overflows', track.scrollHeight > view.clientHeight + 0.5);
  foot.innerHTML = pages.length > 1 ? pages.map((_, i) => `<i class="${i === pageIdx ? 'on' : ''}"></i>`).join('') : '';
}
addEventListener('resize', () => requestAnimationFrame(layout));

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
