// Display logic shared by tv.html and overlay.html. Markup and CSS own the look;
// this file only fills [data-bind] text, sets CSS variables and state classes.
import { connect, courtFromPath, clockMs, fmtClock, periodLabel, bindText } from './common.js';

const court = courtFromPath();
const role = document.body.dataset.role || 'tv';
const root = document.documentElement;
let snap = null;

function logo(el, team) {
  if (!el) return;
  if (team.logo) {
    if (el.dataset.src !== team.logo) { el.innerHTML = ''; const img = new Image(); img.src = team.logo; img.alt = ''; el.appendChild(img); el.dataset.src = team.logo; }
  } else { el.dataset.src = ''; el.textContent = (team.short || team.name || '?').slice(0, 1); }
}
function dots(el, left, total) {
  if (!el) return;
  el.innerHTML = Array.from({ length: total }, (_, i) => `<span class="${i < left ? 'on' : 'off'}"></span>`).join('');
}

function render() {
  if (!snap) return;
  const g = snap.game, s = g?.state;
  root.classList.toggle('no-game', !g);
  const view = {
    league: snap.league, court: snap.court?.name,
    gameInfo: g ? [snap.court?.name, g.division].filter(Boolean).join(' · ') : 'Waiting for the next game',
    upNext: (snap.upNext || []).map((u) => `${u.time || ''}  ${u.home} vs ${u.away}`).join('   ·   ') || 'Thanks for coming!',
  };
  if (g) {
    Object.assign(view, {
      home: { ...g.home, ...s.home }, away: { ...g.away, ...s.away },
      period: periodLabel(s.period, s.rules.periods), banner: s.banner || '',
    });
    root.style.setProperty('--home-color', g.home.color); root.style.setProperty('--home-accent', g.home.accent);
    root.style.setProperty('--away-color', g.away.color); root.style.setProperty('--away-accent', g.away.accent);
    root.classList.toggle('home-bonus', g.home.bonus); root.classList.toggle('away-bonus', g.away.bonus);
    root.classList.toggle('poss-home', s.possession === 'home'); root.classList.toggle('poss-away', s.possession === 'away');
    root.classList.toggle('has-banner', !!s.banner); root.classList.toggle('final', s.status === 'final');
    root.classList.toggle('clock-running', s.clock.running);
    logo(document.querySelector('[data-logo="home"]'), g.home); logo(document.querySelector('[data-logo="away"]'), g.away);
    dots(document.querySelector('[data-timeouts="home"]'), s.home.timeoutsLeft, s.rules.timeoutsPerGame);
    dots(document.querySelector('[data-timeouts="away"]'), s.away.timeoutsLeft, s.rules.timeoutsPerGame);
  }
  bindText(document, view);
}

const conn = connect({
  court, role,
  onState: (m) => { snap = m; render(); },
  onStatus: (st) => { root.dataset.conn = st; },
});

// Repaint only the clock, every animation frame, from server time.
function tick() {
  const el = document.querySelector('[data-clock]');
  if (el && snap?.game) { const t = fmtClock(clockMs(snap.game.state.clock, conn.serverNow())); if (el.textContent !== t) el.textContent = t; }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
