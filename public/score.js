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
const LOADED_KEY = `sb-loaded-${court}`;     // the game this device loaded/resumed (else: offer Resume)
let snap = null, presence = {}, authed = false, lockUntil = 0, lockTimer = null;
// Weekly court QR: /score/<court>?t=<token> signs in once, then the token is removed from the address bar.
let qrToken = new URLSearchParams(location.search).get('t');
if (qrToken) history.replaceState(null, '', location.pathname);
/** #pin-err text + data-kind (lockout | wrong | info | busy | readonly) for Sage's styles. */
// data-kind: lockout | wrong | info | busy | readonly. data-cause (optional): qr (QR lockout) | revoked (QR replaced).
function setErr(text, kind = 'info', cause = '') { const el = $('#pin-err'); el.textContent = text; el.dataset.kind = text ? kind : ''; if (cause && text) el.dataset.cause = cause; else delete el.dataset.cause; }
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const device = localStorage.getItem(DEVICE_KEY) || (localStorage.setItem(DEVICE_KEY, uid()), localStorage.getItem(DEVICE_KEY));

// id -> { msg, sentAt }. Replayed after (re)auth and retried until acked; the server dedupes by id.
const pending = new Map((() => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return []; } })().map((m) => [m.id, { msg: m, sentAt: 0 }]));
const savePending = () => localStorage.setItem(PENDING_KEY, JSON.stringify([...pending.values()].map((p) => p.msg)));

const conn = connect({
  court, role: 'score',
  onStatus: (st) => {
    root.dataset.conn = st;
    // Also on each screen root (picker, resume, confirm dialog in the top layer, PIN gate), so CSS can dim them offline.
    for (const id of ['picker', 'resume', 'confirm-dialog', 'pin-gate', 'app']) { const el = document.getElementById(id); if (el) el.dataset.conn = st; }
    if (st !== 'online') authed = false; // each new socket must re-authenticate before we send
    if (st === 'online') authenticate();
    render();
  },
  onState: (m) => { snap = m; presence = m.presence || presence; render(); },
  onMessage: (m) => {
    if (m.type === 'ack' && m.loaded) { localStorage.setItem(LOADED_KEY, String(m.loaded)); render(); }
    if (m.type === 'auth') {
      if (m.ok) {
        authed = true; clearLock();
        if (m.session) localStorage.setItem(SESSION_KEY, m.session);
        $('#pin-gate').hidden = true; $('#app').hidden = false; $('#pin').value = '';
        flush(true);
      } else {
        authed = false;
        if (m.locked) startLock(m.retryAfter, m.cause);
        else {
          if (m.needPin) localStorage.removeItem(SESSION_KEY);
          // A replaced QR (old printout scanned, or a signed-in phone after Regenerate) gets the same "revoked" treatment.
          const revoked = m.sessionRevoked || (m.qrInvalid && m.reason === 'revoked');
          const kind = /read-only/.test(m.error || '') ? 'readonly' : revoked ? 'info' : (m.qrInvalid || /Wrong PIN/.test(m.error || '')) ? 'wrong' : 'info';
          showGate(m.error || 'Wrong PIN', kind, revoked ? 'revoked' : '');
        }
      }
    }
    if (m.type === 'ack') { pending.delete(m.id); savePending(); render(); }
    if (m.type === 'error') {
      if (m.id && /game changed|complete/.test(m.error) && pending.has(m.id)) toast(/complete/.test(m.error) ? 'The game is complete; a saved tap was not applied.' : 'A saved tap was for an earlier game and was discarded.', 'warn');
      if (m.id && !/PIN required/.test(m.error)) { pending.delete(m.id); savePending(); } // keep taps refused only for auth; they retry after re-auth
      if (/PIN required/.test(m.error)) { authed = false; authenticate(); }
      else if (!/resyncing/.test(m.error)) toast(m.error, 'error');
      render();
    }
  },
});

function authenticate() {
  if (qrToken && conn.send({ type: 'auth', qr: qrToken, device })) { qrToken = null; setErr('Signing in…', 'busy'); return; }
  const session = localStorage.getItem(SESSION_KEY);
  if (session) conn.send({ type: 'auth', session, device });
  else showGate();
}
function showGate(err = '', kind = 'info', cause = '') {
  $('#app').hidden = true; $('#pin-gate').hidden = false;
  if (!lockUntil) setErr(err, kind, cause);
  bindText(document, { court: snap?.court?.name || court });
  render();
}
// Lockout countdown (QA r2-D): visible, ticking, Unlock disabled until it ends.
let lockCause = 'pin';
function startLock(sec, cause) {
  lockCause = cause === 'qr' ? 'qr' : 'pin';
  lockUntil = Date.now() + (sec || 30) * 1000;
  showGate();
  const btn = $('#pin-gate button');
  const tick = () => {
    const left = Math.ceil((lockUntil - Date.now()) / 1000);
    if (left <= 0) { clearLock(); setErr('You can try the PIN again now.', 'info'); authenticate(); return; }
    btn.disabled = true;
    setErr(lockCause === 'qr' ? `Too many invalid QR codes on this phone. Try again in ${left} s, then scan this week's code or enter the court PIN.` : `Too many wrong PINs. Try again in ${left} s.`, 'lockout', lockCause === 'qr' ? 'qr' : '');
  };
  clearInterval(lockTimer); tick(); lockTimer = setInterval(tick, 250);
}
function clearLock() { lockUntil = 0; clearInterval(lockTimer); $('#pin-gate button').disabled = false; }

$('#pin-gate').addEventListener('submit', (e) => {
  e.preventDefault();
  if (lockUntil > Date.now()) return; // button is disabled; countdown is showing
  const pin = $('#pin').value.trim();
  if (!pin) { setErr('Enter the court PIN.', 'info'); return; }
  if (!conn.send({ type: 'auth', pin, device })) setErr('Not connected yet. Reconnecting… try again in a moment.', 'busy');
  else setErr('Checking…', 'busy');
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
// Confirm dialog (Load / Complete game). Falls back to confirm() where <dialog> isn't supported.
function confirmBox(text, okLabel) {
  const d = $('#confirm-dialog');
  if (!d.showModal) return Promise.resolve(confirm(text));
  $('#confirm-text').textContent = text; $('#confirm-ok').textContent = okLabel;
  d.dataset.kind = okLabel === 'Load' ? 'load' : 'complete';
  return new Promise((res) => { d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }); d.returnValue = ''; d.showModal(); });
}
const matchup = (x) => `${x.label || x.grade ? (x.label || x.grade) + ' · ' : ''}${x.home} vs ${x.away}`;
$('#picker-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-game-id]'); if (!b) return;
  const x = (snap?.today || []).find((t) => String(t.id) === b.dataset.gameId); if (!x) return;
  if (!(await confirmBox(`Load ${matchup(x)} on ${snap.court.name} Court?`, 'Load'))) return;
  if (!conn.send({ type: 'load', id: uid(), gameId: x.id })) toast('Not connected. Try again in a moment.', 'warn');
});
$('#resume-ok').addEventListener('click', () => { if (snap?.game) { localStorage.setItem(LOADED_KEY, String(snap.game.id)); render(); } });
$('#complete-game').addEventListener('click', async () => {
  const g = snap?.game; if (!g) return;
  const s = g.state;
  if (await confirmBox(`Complete this game? The final score ${g.home.name} ${s.home.score} – ${s.away.score} ${g.away.name} will be locked.`, 'Complete game')) send('cmd', { cmd: { type: 'END_GAME' } });
});
$('#set-clock').addEventListener('click', () => {
  const cur = snap?.game ? fmtClock(clockMs(snap.game.state.clock, conn.serverNow())) : '';
  const v = prompt('Set clock (mm:ss)', cur); if (!v) return;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim()) || /^(\d{1,2})$/.exec(v.trim());
  if (!m) return toast('Use mm:ss, e.g. 08:00');
  send('cmd', { cmd: { type: 'CLOCK_SET', ms: (Number(m[1]) * 60 + Number(m[2] || 0)) * 1000 } });
});

function toast(t, kind = 'info') {
  const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); el.dataset.kind = kind;
  el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 3000);
}
const STATUS_LABEL = { scheduled: 'Scheduled', active: 'Active', complete: 'Complete' };
/** Picker / resume / game: which part of the app this device shows. */
function renderMode() {
  const g = snap?.game;
  const mode = !g ? 'picker' : (localStorage.getItem(LOADED_KEY) === String(g.id) || [...pending.values()].some((p) => p.msg.gameId === g.id) ? 'game' : 'resume');
  if (!g) localStorage.removeItem(LOADED_KEY);
  root.dataset.view = mode;
  $('#picker').hidden = mode !== 'picker'; $('#resume').hidden = mode !== 'resume';
  $('main.grid').hidden = mode !== 'game'; $('footer.foot').hidden = mode !== 'game';
  if (mode === 'resume') $('#resume-text').textContent = `${matchup({ grade: g.grade, label: g.label, home: g.home.name, away: g.away.name })} is active on ${snap.court.name} Court.`;
  if (mode === 'picker') {
    const list = snap?.today || [];
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = list.map((x) => `<li><button type="button" class="pick" data-game-id="${x.id}" data-status="${x.status}"><span class="pick-time">${x.is_today === false && x.day ? esc(x.day) + ' · ' : ''}${esc(x.time)}</span> <span class="pick-grade">${esc(x.label || x.grade || '')}</span> <span class="pick-matchup">${esc(x.home)} vs ${esc(x.away)}</span> <span class="status-badge" data-status="${x.status}">${STATUS_LABEL[x.status] || esc(x.status)}</span></button></li>`).join('');
    if ($('#picker-list').innerHTML !== html) $('#picker-list').innerHTML = html;
    $('#picker-empty').hidden = list.length > 0;
  }
}

function render() {
  const online = conn.isOpen();
  const g = snap?.game, s = g?.state;
  root.classList.toggle('no-game', !g);
  root.classList.toggle('is-final', s?.status === 'complete');
  renderMode();
  const p = $('#pending'); p.hidden = pending.size === 0; p.textContent = `${pending.size} tap${pending.size === 1 ? '' : 's'} sending…`;
  const view = {
    court: snap?.court?.name || court,
    title: g ? `${[g.label || g.grade, `${g.home.name} vs ${g.away.name}`].filter(Boolean).join(' · ')} · ${snap.court.name}` : `UpwardScoreboard · ${snap?.court?.name || court}`,
    grade: g?.label || g?.grade || '',
    connText: online ? '● Online' : '● Offline · reconnecting…',
    // Presence is stale while this phone is offline: don't show a green "TV connected" from before the drop.
    tvText: !online ? '○ TV status unknown (reconnecting)' : presence.displays ? `● TV connected${presence.controllers > 1 ? ` · ${presence.controllers} scorekeepers` : ''}` : '○ No TV connected',
  };
  const stale = !online;
  root.classList.toggle('presence-stale', stale); // hook for Sage: grey the TV pill
  const tvPill = document.querySelector('.pill.tv'); if (tvPill) { if (stale) tvPill.dataset.stale = 'true'; else delete tvPill.dataset.stale; }
  root.classList.toggle('tv-off', !stale && !presence.displays);
  root.classList.toggle('two-controllers', !stale && presence.controllers > 1);
  if (g) {
    const side = (k) => ({
      ...g[k], ...s[k],
      foulText: `${s[k].fouls}${g[k === 'home' ? 'away' : 'home'].bonus ? ' · BONUS' : ''}`, // this team's fouls put the OTHER team in bonus
      toText: `${s[k].timeoutsLeft} left${s.rules.timeoutsPerHalf ? ' this half' : ''}`,
    });
    Object.assign(view, {
      home: side('home'), away: side('away'),
      period: periodLabel(s.period, s.rules.periods), periods: s.rules.periods,
      // 2nd Grade and below: TV/overlay/lobby hide the score; it is still kept here for the record.
      scoreNote: g.hideScore ? ' · score hidden on TV (2nd Grade & below)' : '',
      possText: s.possession ? (s.possession === 'home' ? `◀ ${g.home.name}` : `${g.away.name} ▶`) : 'not set',
      undoText: g.canUndo && s.lastLabel ? `last: ${s.lastLabel}` : '',
    });
    root.dataset.homeSide = g.homeSide || 'light'; // for a small light/dark chip (no cheer data here)
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
