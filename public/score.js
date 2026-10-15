// Scorekeeper controller logic. Sends intent commands; the server applies them and
// broadcasts the authoritative state back. Look & feel lives in score.css.
import { connect, courtFromPath, displayNow, clockMs, fmtClock, periodLabel, bindText } from './common.js';

const court = courtFromPath();
const $ = (s) => document.querySelector(s);
const root = document.documentElement;
const PIN_KEY = `sb-pin-${court}`;
let snap = null, presence = {}, authed = false;
const pending = new Map(); // id -> message, replayed after reconnect (server dedupes by id)

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());

const conn = connect({
  court, role: 'score',
  onStatus: (st) => {
    root.dataset.conn = st;
    if (st !== 'online') authed = false; // each new socket must re-authenticate before we send
    if (st === 'online') { const pin = localStorage.getItem(PIN_KEY); if (pin) conn.send({ type: 'auth', pin }); else showGate(); }
    render();
  },
  onState: (m) => { snap = m; presence = m.presence || presence; render(); },
  onMessage: (m) => {
    if (m.type === 'auth') {
      authed = m.ok;
      if (m.ok) { $('#pin-gate').hidden = true; $('#app').hidden = false; flush(); }
      else if (m.locked) showGate(m.error || 'Too many attempts. Please wait.'); // keep the saved PIN; just wait
      else { localStorage.removeItem(PIN_KEY); showGate(m.error || 'Wrong PIN'); }
    }
    if (m.type === 'ack') { pending.delete(m.id); render(); }
    if (m.type === 'error') {
      if (m.id) pending.delete(m.id);
      if (!/resyncing/.test(m.error)) toast(m.error);
      render();
    }
  },
});

function showGate(err = '') { $('#app').hidden = true; $('#pin-gate').hidden = false; $('#pin-err').textContent = err; bindText(document, { court: snap?.court?.name || court }); }
$('#pin-gate').addEventListener('submit', (e) => {
  e.preventDefault(); const pin = $('#pin').value.trim();
  localStorage.setItem(PIN_KEY, pin); conn.send({ type: 'auth', pin });
});

function send(type, extra = {}) {
  if (!snap?.game) return;
  const msg = { type, id: uid(), gameId: snap.game.id, ...extra };
  pending.set(msg.id, msg);
  if (navigator.vibrate) navigator.vibrate(15);
  if (authed) conn.send(msg);
  render();
}
function flush() { for (const m of pending.values()) conn.send(m); }

document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => send('cmd', { cmd: JSON.parse(b.dataset.cmd) })));
$('#undo').addEventListener('click', () => send('undo'));
$('#redo').addEventListener('click', () => send('redo'));
$('#banner').addEventListener('click', () => send('cmd', { cmd: { type: 'BANNER', text: snap?.game?.state.banner ? null : 'HALFTIME' } }));
$('#end').addEventListener('click', () => { if (confirm('End the game and save the final score?')) send('cmd', { cmd: { type: 'END_GAME' } }); });
$('#set-clock').addEventListener('click', () => {
  const cur = snap?.game ? fmtClock(clockMs(snap.game.state.clock, conn.serverNow())) : '';
  const v = prompt('Set clock (mm:ss)', cur); if (!v) return;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim()) || /^(\d{1,2})$/.exec(v.trim());
  if (!m) return toast('Use mm:ss, e.g. 08:00');
  send('cmd', { cmd: { type: 'CLOCK_SET', ms: (Number(m[1]) * 60 + Number(m[2] || 0)) * 1000 } });
});

function toast(t) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 3000); }

function render() {
  const online = conn.isOpen();
  const g = snap?.game, s = g?.state;
  root.classList.toggle('no-game', !g);
  root.classList.toggle('is-final', s?.status === 'final');
  const p = $('#pending'); p.hidden = pending.size === 0; p.textContent = `${pending.size} tap${pending.size === 1 ? '' : 's'} sending…`;
  const view = {
    court: snap?.court?.name || court,
    title: g ? `UpwardScoreboard · ${g.home.name} vs ${g.away.name} · ${snap.court.name}` : `UpwardScoreboard · ${snap?.court?.name || court}`,
    connText: online ? '● Online' : '● Offline · reconnecting…',
    tvText: presence.displays ? `● TV connected${presence.controllers > 1 ? ` · ${presence.controllers} scorekeepers` : ''}` : '○ No TV connected',
  };
  root.classList.toggle('tv-off', !presence.displays);
  root.classList.toggle('two-controllers', presence.controllers > 1);
  if (g) {
    const side = (k) => ({
      ...g[k], ...s[k],
      foulText: `${s[k].fouls}${g[k === 'home' ? 'away' : 'home'].bonus ? ' · BONUS' : ''}`, // this team's fouls put the OTHER team in bonus
      toText: `${s[k].timeoutsLeft} left`,
    });
    Object.assign(view, {
      home: side('home'), away: side('away'),
      period: periodLabel(s.period, s.rules.periods), periods: s.rules.periods,
      possText: s.possession ? (s.possession === 'home' ? `◀ ${g.home.name}` : `${g.away.name} ▶`) : 'not set',
      undoText: g.canUndo && s.lastLabel ? `last: ${s.lastLabel}` : '',
    });
    root.style.setProperty('--home-color', g.home.color); root.style.setProperty('--home-accent', g.home.accent);
    root.style.setProperty('--away-color', g.away.color); root.style.setProperty('--away-accent', g.away.accent);
    const t = $('#clock-toggle');
    t.dataset.cmd = JSON.stringify({ type: s.clock.running ? 'CLOCK_STOP' : 'CLOCK_START' });
    t.textContent = s.clock.running ? '■ STOP CLOCK' : '▶ START CLOCK';
    t.classList.toggle('stop', s.clock.running);
    $('#undo').disabled = !g.canUndo; $('#redo').disabled = !g.canRedo;
    $('#banner').textContent = s.banner === 'HALFTIME' ? 'Hide "Halftime"' : 'Show "Halftime"';
  }
  bindText(document, view);
}

function tick() {
  const el = $('[data-clock]');
  if (el && snap?.game) { const t = fmtClock(clockMs(snap.game.state.clock, displayNow(conn))); if (el.textContent !== t) el.textContent = t; }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
// keep the screen awake on phones that support it
if ('wakeLock' in navigator) { const lock = () => navigator.wakeLock.request('screen').catch(() => {}); lock(); document.addEventListener('visibilitychange', () => !document.hidden && lock()); }
