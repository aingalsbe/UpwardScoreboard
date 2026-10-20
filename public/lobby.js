// Lobby TV v2 logic (no styling): picks live + next per court (lobby-view.js) and renders Sage's mockup markup
// (deliverables/mockups/lobby-v2) with its hooks. Live clocks tick from server time like the TV.
import { connect, displayNow, clockMs, fmtClock } from './common.js';
import { planLobby, headerText, ampm, quarter, emptyNote, COURT_LABEL } from './lobby-view.js';

const root = document.documentElement;
const qs = new URLSearchParams(location.search), query = new URLSearchParams();
for (const k of ['day', 'date']) if (qs.get(k)) query.set(k, qs.get(k));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = document.querySelector('main');
let snap = null;
const COURT_NAME = { west: 'WEST COURT', east: 'EAST COURT', full: 'FULL COURT' };
const clockText = (g) => (g?.clock ? fmtClock(clockMs(g.clock, displayNow(conn))).replace(/^0(\d):/, '$1:') : '');

/** Locker pill: empty -> data-empty (visibility:hidden in lobby.css, column kept). */
const locker = (v) => `<div class="locker" data-bind="locker"${v ? '' : ' data-empty'}><small>Locker Room</small><b>${esc(v || '')}</b></div>`;
/** Name + "Coach X" line under it (first name from the server; the prefix is added here). */
const who = (name, coach) => `<div class="who"><div class="name" data-bind="name">${esc(name)}</div><div class="coach" data-bind="coach">${coach ? `Coach ${esc(coach)}` : ''}</div></div>`;
function teamRow(g, side, live) {
  const t = g[side];
  const score = live ? `<span class="score" data-bind="${side}-score">${esc(t.score ?? 0)}</span>` : '<span></span>';
  return `<div class="row ${side}" data-row="${side}">${locker(t.locker)}
      ${who(t.name, t.coach)}${score}<span class="side">${side.toUpperCase()}</span></div>`;
}
/** One game section. Home is always listed first. */
function gameSection(g, slot, note = 'No game right now') {
  if (!g) return `<section class="game ${slot === 'now' ? 'live' : 'next'}" data-slot="${slot}" data-state="empty"><div class="empty-note">${esc(note)}</div></section>`;
  const live = slot === 'now';
  const status = live ? `<div class="status"><span class="tag live">● LIVE</span><span class="when">${esc(quarter(g.period, g.periods))}</span><span class="clock" data-bind="clock" data-game-id="${g.id}">${esc(clockText(g))}</span></div>` : '';
  return `<section class="game ${live ? 'live' : 'next'}" data-slot="${slot}" data-state="${live ? 'live' : 'upcoming'}" data-game-id="${g.id}">${status}${teamRow(g, 'home', live)}${teamRow(g, 'away', live)}</section>`;
}
const tab = (c) => `<div class="tab"><span>${COURT_NAME[c] || esc(c.toUpperCase() + ' COURT')}</span></div>`;
const nextBar = (hm) => `<section class="next-bar" data-slot="next" data-state="upcoming"><span class="nb-label">🕒 UP NEXT</span><span class="nb-dot">·</span><span class="nb-time">Tip-off <span data-bind="time">${esc(ampm(hm))}</span></span></section>`;
/** Unlabeled full-width cheer row for a slot; omitted when the slot has no squad. */
const cheerBand = (c, slot) => (!c ? '' : `<section class="cheer-band ${slot}" data-court="both" data-slot="${slot}">
<div class="row cheer span" data-row="cheer">${locker(c.locker)}
      ${who(c.name, c.coach)}<span class="side">CHEER</span></div></section>`);
const courtsOf = (band) => (band.layout === 'full' ? ['full'] : ['west', 'east']);

function render() {
  const p = planLobby(snap.games || [], snap.cheerSlots || []);
  document.querySelector('[data-bind="header"]').textContent = headerText(snap.date, p.header);
  document.querySelector('[data-bind="sub"]').textContent = `${snap.church?.name || 'Lenexa Baptist Church'} · Upward Basketball`.toUpperCase();
  root.dataset.empty = String(p.empty);
  if (p.empty) { main.className = 'full'; main.innerHTML = `<div class="court" data-court="full"><section class="game" data-state="empty"><div class="empty-note">No more games today</div></section></div>`; return; }
  const allFull = (!p.now || p.now.layout === 'full') && (!p.next || p.next.layout === 'full');
  if (allFull) { // Friday: one Full Court panel, live then the UP NEXT bar then the next game below it
    main.className = 'full';
    main.innerHTML = `<div class="court" data-court="full">${tab('full')}
<div class="pair">${p.now ? gameSection(p.now.courts.full, 'now') : ''}${p.next ? nextBar(p.nextTime) + '\n' + gameSection(p.next.courts.full, 'next') : ''}</div></div>`
      + cheerBand(p.cheer.now, 'now') + cheerBand(p.cheer.next, 'next');
    return;
  }
  // Split day: band.now (tabs + live per court), cheer for the live slot, UP NEXT bar, band.next, cheer for the next slot.
  main.className = 'split';
  // Mixed day (Full Court and split): next courts have no tabs, so each gets a real text label (WEST COURT / EAST COURT / FULL COURT).
  const label = (c) => `<span class="court-label" data-bind="court">${COURT_LABEL[c] || esc(c.toUpperCase())}</span>`;
  const band = (b, slot, withTabs) => `<div class="band ${slot}">\n${courtsOf(b).map((c) => `<div class="court" data-court="${c}">${withTabs ? tab(c) : ''}${slot === 'next' && p.mixed ? label(c) : ''}${gameSection(b.courts[c], slot, emptyNote(p, c))}</div>`).join('\n')}\n</div>`;
  main.innerHTML = (p.now ? band(p.now, 'now', true) + cheerBand(p.cheer.now, 'now') : '')
    + (p.next ? '\n' + nextBar(p.nextTime) + '\n' + band(p.next, 'next', !p.now) + cheerBand(p.cheer.next, 'next') : '');
}

const conn = connect({
  court: '*', role: 'schedule', query: query.toString(),
  onState: (m) => { if (m.kind === 'schedule') { snap = m; render(); } },
  onStatus: (st) => { root.dataset.conn = st; },
});

function tick() { // live clocks from server time (frozen while offline)
  if (snap) for (const el of document.querySelectorAll('[data-bind="clock"][data-game-id]')) {
    const g = snap.games.find((x) => String(x.id) === el.dataset.gameId);
    const t = clockText(g); if (t && el.textContent !== t) el.textContent = t;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
