// Display logic shared by tv.html and overlay.html. Markup and CSS own the look;
// this file only fills [data-bind] text, sets CSS variables and state classes.
import { connect, courtFromPath, displayNow, clockMs, fmtClock, periodLabel, bindText } from './common.js';

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

/** Image binds (church-logo, home-cheer-logo, away-cheer-logo): set src, hidden when there's no value. */
function img(key, src) {
  document.querySelectorAll(`img[data-bind="${key}"]`).forEach((el) => {
    if (src) { if (el.getAttribute('src') !== src) el.src = src; el.hidden = false; } else { el.removeAttribute('src'); el.hidden = true; }
  });
}

function render() {
  if (!snap) return;
  const g = snap.game, s = g?.state;
  if (snap.season) { root.style.setProperty('--season-dark', snap.season.dark); root.style.setProperty('--season-light', snap.season.light); }
  img('church-logo', snap.church?.logo);
  const hc = g?.home.cheer, ac = g?.away.cheer;
  root.classList.toggle('has-home-cheer', !!hc); root.classList.toggle('has-away-cheer', !!ac);
  img('home-cheer-logo', hc?.logo); img('away-cheer-logo', ac?.logo);
  if (g) { root.dataset.homeSide = g.homeSide || 'light'; root.dataset.swapped = String(!!g.swapped); }
  // Idle screen (no active game): next scheduled game, else church branding; plus today's last final.
  const nx = snap.nextUp, lf = snap.lastFinal;
  root.classList.toggle('has-next-up', !g && !!nx); root.classList.toggle('has-last-final', !g && !!lf);
  root.dataset.status = g ? g.state.status : 'idle';
  root.classList.toggle('no-game', !g);
  const view = {
    league: snap.league, court: snap.court?.name,
    'church-name': snap.church?.name || '', 'home-cheer': hc?.name || '', 'away-cheer': ac?.name || '',
    gameInfo: g ? [snap.court?.name, g.grade || g.division, `${g.home.name} vs ${g.away.name}`].filter(Boolean).join(' · ') : 'Waiting for the next game',
    grade: g?.grade || '',
    next: nx ? { time: nx.is_today ? nx.time : `${nx.day} ${nx.time}`, grade: nx.grade || '', matchup: `${nx.home} vs ${nx.away}` } : { time: '', grade: '', matchup: '' },
    lastFinal: lf ? `Final: ${lf.grade ? lf.grade + ' · ' : ''}${lf.home} ${lf.final_home ?? ''} – ${lf.final_away ?? ''} ${lf.away}` : '', matchup: g ? `${[g.grade, `${g.home.name} vs ${g.away.name}`].filter(Boolean).join(' · ')}` : '',
    upNext: (snap.upNext || []).map((u) => `${u.is_today === false && u.day ? u.day + ' · ' : ''}${u.time || ''}  ${u.grade ? u.grade + ' · ' : ''}${u.home} vs ${u.away}`).join('   ·   ') || 'Thanks for coming!',
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
  } else {
    // Idle: drop every per-game side class and color variable (incl. the ones contrast.js derived), so nothing
    // from the last game (e.g. home-light) leaks into the Next up screen.
    for (const side of ['home', 'away']) {
      for (const v of ['color', 'accent', 'fg', 'logo-fg', 'on-dark', 'ring']) root.style.removeProperty(`--${side}-${v}`);
      root.classList.remove(`${side}-light`, `${side}-accent-fixed`, `${side}-bonus`, `poss-${side}`);
    }
    root.classList.remove('has-banner', 'final', 'clock-running');
    delete root.dataset.homeSide; delete root.dataset.swapped;
  }
  bindText(document, view);
}

const conn = connect({
  court, role,
  onState: (m) => { snap = m; render(); },
  onStatus: (st) => { root.dataset.conn = st; for (const id of ['idle', 'next-up']) { const el = document.getElementById(id); if (el) el.dataset.conn = st; } },
});

// Repaint only the clock, every animation frame, from server time.
function tick() {
  const el = document.querySelector('[data-clock]');
  if (el && snap?.game) { const t = fmtClock(clockMs(snap.game.state.clock, displayNow(conn))); if (el.textContent !== t) el.textContent = t; }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
