// Display logic shared by tv.html and overlay.html. Markup and CSS own the look;
// this file only fills [data-bind] text, sets CSS variables and state classes.
import { fillTeamLogo, fillImg } from './logo-badge.js';
import { connect, courtFromPath, displayNow, clockMs, fmtClock, periodLabel, bindText, timeoutCap } from './common.js';

const court = courtFromPath();
const role = document.body.dataset.role || 'tv';
const root = document.documentElement;
let snap = null;

// Broken logo (404 etc.) -> the initial, never an empty circle (logo-badge.js).
function logo(el, team) { fillTeamLogo(el, team.logo, team.short || team.name); }
function dots(el, left, total) {
  if (!el) return;
  el.innerHTML = Array.from({ length: total }, (_, i) => `<span class="${i < left ? 'on' : 'off'}"></span>`).join('');
}

/** Image binds (church-logo, cheer-logo): set src, hidden when there's no value. */
function img(key, src) {
  document.querySelectorAll(`img[data-bind="${key}"]`).forEach((el) => {
    fillImg(el, src); // missing or broken -> hidden (no broken-image icon)
  });
}

function render() {
  if (!snap) return;
  const g = snap.game, s = g?.state;
  if (snap.season) { root.style.setProperty('--season-dark', snap.season.dark); root.style.setProperty('--season-light', snap.season.light); }
  img('church-logo', snap.church?.logo);
  // One cheer squad per game (not per side): .cheer in section.center, root class has-cheer.
  const ch = g?.cheer;
  root.classList.toggle('has-cheer', !!ch);
  img('cheer-logo', ch?.logo);
  if (g) { root.dataset.homeSide = g.homeSide || 'light'; root.dataset.swapped = String(!!g.swapped); }
  // Idle screen (no active game): next scheduled game, else church branding; plus today's last final.
  const nx = snap.nextUp, lf = snap.lastFinal;
  root.classList.toggle('has-next-up', !g && !!nx); root.classList.toggle('has-last-final', !g && !!lf);
  root.dataset.status = g ? g.state.status : 'idle';
  root.classList.toggle('no-game', !g);
  root.classList.toggle('no-score', !!g?.hideScore); // 2nd Grade and below: clock + period only (see tv.css / overlay.css)
  const view = {
    league: snap.league, court: snap.court?.name,
    'church-name': snap.church?.name || '', cheer: ch?.name || '',
    gameInfo: g ? [snap.court?.name, g.label || g.grade || g.division, `${g.home.name} vs ${g.away.name}`].filter(Boolean).join(' · ') : 'Waiting for the next game',
    grade: g?.label || g?.grade || '',
    next: nx ? { time: nx.is_today ? nx.time : `${nx.day} ${nx.time}`, grade: nx.label || nx.grade || '', matchup: `${nx.home} vs ${nx.away}` } : { time: '', grade: '', matchup: '' },
    // 2nd Grade and below (hideScore): the server sends no score, so the final line names the matchup only.
    lastFinal: lf ? `Final: ${lf.label || lf.grade ? (lf.label || lf.grade) + ' · ' : ''}${lf.hideScore ? `${lf.home} vs ${lf.away}` : `${lf.home} ${lf.final_home ?? ''} – ${lf.final_away ?? ''} ${lf.away}`}` : '', matchup: g ? `${[g.label || g.grade, `${g.home.name} vs ${g.away.name}`].filter(Boolean).join(' · ')}` : '',
    upNext: (snap.upNext || []).map((u) => `${u.is_today === false && u.day ? u.day + ' · ' : ''}${u.time || ''}  ${u.label || u.grade ? (u.label || u.grade) + ' · ' : ''}${u.home} vs ${u.away}`).join('   ·   ') || 'Thanks for coming!',
  };
  if (g) {
    Object.assign(view, {
      home: { ...g.home, ...s.home, score: g.hideScore ? '' : s.home.score }, away: { ...g.away, ...s.away, score: g.hideScore ? '' : s.away.score },
      period: periodLabel(s.period, s.rules.periods), banner: s.banner || '',
    });
    root.style.setProperty('--home-color', g.home.color); root.style.setProperty('--home-accent', g.home.accent);
    root.style.setProperty('--away-color', g.away.color); root.style.setProperty('--away-accent', g.away.accent);
    root.classList.toggle('home-bonus', g.home.bonus); root.classList.toggle('away-bonus', g.away.bonus);
    root.classList.toggle('poss-home', s.possession === 'home'); root.classList.toggle('poss-away', s.possession === 'away');
    root.classList.toggle('has-banner', !!s.banner); root.classList.toggle('final', s.status === 'final');
    root.classList.toggle('clock-running', s.clock.running);
    logo(document.querySelector('[data-logo="home"]'), g.home); logo(document.querySelector('[data-logo="away"]'), g.away);
    dots(document.querySelector('[data-timeouts="home"]'), s.home.timeoutsLeft, timeoutCap(s.rules));
    dots(document.querySelector('[data-timeouts="away"]'), s.away.timeoutsLeft, timeoutCap(s.rules));
  } else {
    // Idle: drop the per-game colors and state classes so nothing from the last game leaks into the Next up screen.
    // The derived --*-fg/logo-fg/on-dark/ring and *-light/*-accent-fixed stay: contrast.js owns them and recomputes
    // them from the (season default) colors right after this render (Avery R21b: removing them left #111/#fff).
    for (const side of ['home', 'away']) {
      for (const v of ['color', 'accent']) root.style.removeProperty(`--${side}-${v}`);
      root.classList.remove(`${side}-bonus`, `poss-${side}`);
    }
    root.classList.remove('has-banner', 'final', 'clock-running');
    delete root.dataset.homeSide; delete root.dataset.swapped;
  }
  bindText(document, view);
  window.Contrast?.reapply?.(); // always re-derive fg vars after a render (idle -> game, game -> idle -> game)
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
