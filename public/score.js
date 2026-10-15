// Scorekeeper controller logic. Sends intent commands; the server applies them and
// broadcasts the authoritative state back. Look & feel lives in score.css.
import { connect, courtFromPath, displayNow, clockMs, fmtClock, periodLabel, bindText } from './common.js';

const court = courtFromPath();
const $ = (s) => document.querySelector(s);
const root = document.documentElement;
const SESSION_KEY = `sb-session-${court}`;   // court-scoped session token (12 h) issued after a correct PIN
const PENDING_KEY = `sb-pending-${court}`;   // unsent taps survive closing/reloading the page (QA #6)
const DEVICE_KEY = 'sb-device';              // random per-device id: wrong-PIN counting is per court + device
localStorage.removeItem(`sb-pin-${court}`);  // older builds stored the PIN itself; sessions replace that
let snap = null, presence = {}, authed = false, lockUntil = 0, lockTimer = null;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const device = localStorage.getItem(DEVICE_KEY) || (localStorage.setItem(DEVICE_KEY, uid()), localStorage.getItem(DEVICE_KEY));

// id -> { msg, sentAt }. Replayed after (re)auth and retried until acked; the server dedupes by id.
const pending = new Map((() => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return []; } })().map((m) => [m.id, { msg: m, sentAt: 0 }]));
const savePending = () => localStorage.setItem(PENDING_KEY, JSON.stringify([...pending.values()].map((p) => p.msg)));

const conn = connect({
  court, role: 'score',
  onStatus: (st) => {
    root.dataset.conn = st;
    if (st !== 'online') authed = false; // each new socket must re-authenticate before we send
    if (st === 'online') authenticate();
    render();
  },
  onState: (m) => { snap = m; presence = m.presence || presence; render(); },
  onMessage: (m) => {
    if (m.type === 'auth') {
      if (m.ok) {
        authed = true; clearLock();
        if (m.session) localStorage.setItem(SESSION_KEY, m.session);
        $('#pin-gate').hidden = true; $('#app').hidden = false; $('#pin').value = '';
        flush(true);
      } else {
        authed = false;
        if (m.locked) startLock(m.retryAfter, m.error);
        else { if (m.needPin) localStorage.removeItem(SESSION_KEY); showGate(m.error || 'Wrong PIN'); }
      }
    }
    if (m.type === 'ack') { pending.delete(m.id); savePending(); render(); }
    if (m.type === 'error') {
      if (m.id && /game changed/.test(m.error) && pending.has(m.id)) toast('A saved tap was for an earlier game and was discarded.');
      if (m.id && !/PIN required/.test(m.error)) { pending.delete(m.id); savePending(); } // keep taps refused only for auth; they retry after re-auth
      if (/PIN required/.test(m.error)) { authed = false; authenticate(); }
      else if (!/resyncing/.test(m.error)) toast(m.error);
      render();
    }
  },
});

function authenticate() {
  const session = localStorage.getItem(SESSION_KEY);
  if (session) conn.send({ type: 'auth', session, device });
  else showGate();
}
function showGate(err = '') {
  $('#app').hidden = true; $('#pin-gate').hidden = false;
  if (!lockUntil) $('#pin-err').textContent = err;
  bindText(document, { court: snap?.court?.name || court });
  render();
}
// Lockout countdown (QA r2-D): visible, ticking, Unlock disabled until it ends.
function startLock(sec, text) {
  lockUntil = Date.now() + (sec || 30) * 1000;
  showGate();
  const btn = $('#pin-gate button');
  const tick = () => {
    const left = Math.ceil((lockUntil - Date.now()) / 1000);
    if (left <= 0) { clearLock(); $('#pin-err').textContent = 'You can try the PIN again now.'; authenticate(); return; }
    btn.disabled = true;
    $('#pin-err').textContent = `Too many wrong PINs. Try again in ${left} s.`;
  };
  clearInterval(lockTimer); tick(); lockTimer = setInterval(tick, 250);
  void text;
}
function clearLock() { lockUntil = 0; clearInterval(lockTimer); $('#pin-gate button').disabled = false; }

$('#pin-gate').addEventListener('submit', (e) => {
  e.preventDefault();
  if (lockUntil > Date.now()) return; // button is disabled; countdown is showing
  const pin = $('#pin').value.trim();
  if (!pin) { $('#pin-err').textContent = 'Enter the court PIN.'; return; }
  if (!conn.send({ type: 'auth', pin, device })) $('#pin-err').textContent = 'Not connected yet. Reconnecting… try again in a moment.';
  else $('#pin-err').textContent = 'Checking…';
});

function send(type, extra = {}) {
  if (!snap?.game) return;
  const msg = { type, id: uid(), gameId: snap.game.id, ...extra };
  pending.set(msg.id, { msg, sentAt: 0 }); savePending();
  if (navigator.vibrate) navigator.vibrate(15);
  flush();
  render();
}
/** Send queued taps. force = resend everything (after re-auth); otherwise only unsent or unacked > 3 s. */
function flush(force = false) {
  if (!authed) return;
  const now = Date.now();
  for (const p of pending.values()) {
    if (force || now - p.sentAt > 3000) { if (conn.send(p.msg)) p.sentAt = now; }
  }
}
setInterval(() => { if (pending.size) flush(); }, 1000); // never stuck: keeps retrying until acked
window.addEventListener('beforeunload', (e) => { if (pending.size) { e.preventDefault(); e.returnValue = ''; } });

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
