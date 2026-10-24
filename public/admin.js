// Admin logic: CRUD via REST, no framework. Styles live in admin.css.
import { todayGames, resultOf } from './admin-today.js';
import { connect } from './common.js';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let teams = [], courts = [], games = [], squads = [], slots = [], warnings = [];
let slotDate = '', slotsDirty = false; // cheer slot editor: the chosen date, and unsaved edits (A2: refresh must not reset them)
let leagueTz; // all times shown in the league time zone (server TZ), not the viewer's

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const body = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error('login required'); }
  if (r.status === 413 && typeof body !== 'object') throw new Error('Upload too large. Logos must be 1 MB or smaller.');
  if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { status: r.status, body });
  return body;
}
function msg(t, bad = false) { const m = $('#msg'); m.textContent = t; m.className = 'msg ' + (bad ? 'bad' : 'ok'); clearTimeout(msg.t); msg.t = setTimeout(() => (m.textContent = ''), bad ? 20000 : 5000); }
/** Every rule reason, not just the first: 409s carry errors[] (Fri/Sat, game hours, conflicts). */
const errText = (e) => { const all = Array.isArray(e.body?.errors) ? e.body.errors : []; return all.length > 1 ? [e.message, ...all.slice(1)].join(' · ') : e.message; };
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'login required') msg(errText(e), true); } };

function showLogin() { $('#app').hidden = true; $('#login').hidden = false; }
$('#login').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); }
  catch (err) { $('#login-err').textContent = err.message; return; }
  $('#login').hidden = true; leagueTz = (await api('/api/me')).tz; boot();
}));
$('#logout').addEventListener('click', async () => { await fetch('/api/logout'); showLogin(); });

function route() {
  const id = (location.hash || '#today').slice(1);
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== id));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.getAttribute('href') === '#' + id));
}
window.addEventListener('hashchange', route);

const when = (iso) => (iso ? new Date(iso).toLocaleString([], { timeZone: leagueTz, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
// Team-list color (Aaron: season colors only, no individual team colors): every team wears the season light at home
// and the season dark away, so every row shows those two hex values. Re-rendered after a season save and on the
// admin WebSocket push (refreshLive).
let seasonColors = null;
const swatch = () => { if (!seasonColors) return '';
  const L = seasonColors.light.toUpperCase(), D = seasonColors.dark.toUpperCase();
  return `<span class="team-color" title="${esc(`Season colors: light ${L} (home) / dark ${D} (away)`)}"><span class="swatch" style="background:${esc(L)};border-color:${esc(D)}"></span> <code class="hex-val">${esc(L)} / ${esc(D)}</code></span>`; };

function renderTeams(tf = $('#team-grade-filter').value) {
  $('#team-rows').innerHTML = teams.filter((t) => !tf || t.grade === tf).map((t) => `<tr data-team-row="${t.id}"><td>${t.has_logo || t.logo_url ? `<img class="mini" src="${t.has_logo ? `/logos/${t.id}?v=${Date.now()}` : esc(t.logo_url)}" alt=""> ` : ''}${swatch(t)}</td>
    <td>${esc(t.grade || '—')}</td><td>${esc(t.gender || '—')}</td><td>${esc(t.name)}</td><td>${esc(t.short_name)}</td><td>${t.coach ? `Coach ${esc(t.coach)}` : '<span class="muted">—</span>'}</td>
    <td class="right"><button class="link sm" data-edit-team="${t.id}">Edit</button><button class="link sm" data-del-team="${t.id}">Delete</button></td></tr>`).join('');
}

async function load() {
  [teams, courts, games, squads, warnings] = await Promise.all([api('/api/teams'), api('/api/courts'), api('/api/games'), api('/api/cheer-squads'), api('/api/warnings')]);
  if (!slotDate) slotDate = defaultSlotDate();
  slots = await api(`/api/cheer-slots?date=${slotDate}`);
  loadSeason().catch(() => {});
  render();
}

const STATUS = { scheduled: 'Scheduled', active: 'Active', complete: 'Complete' };
const tvPath = (slug) => `/upwardbasketballscores/${encodeURIComponent(slug)}court`;
function gameRow(g, x = {}) {
  const lbl = g.label || g.grade, warn = (g.warnings || []).length ? ` <span class="tag warn-tag" title="${esc(g.warnings.join('\n'))}">⚠ ${g.warnings.length}</span>` : '';
  return `<tr class="${g.on_court ? 'live' : ''}${warn ? ' has-warning' : ''}${x.cls ? ` ${x.cls}` : ''}" data-grade="${esc(g.grade || '')}" data-gender="${esc(g.gender || '')}"${x.data ? ` ${x.data}` : ''}><td class="when">${when(g.scheduled_at)}</td><td class="court">${esc(g.court || '—')}</td>${g.__full ? `<td>${esc(lbl || '—')}</td>` : ''}
    <td class="matchup">${!g.__full && lbl ? `${esc(lbl)} · ` : ''}${x.cls ? `<span class="home">${esc(g.home)}</span> vs <span class="away">${esc(g.away)}</span>` : `${esc(g.home)} vs ${esc(g.away)}`}${warn}${g.moved_from && g.status !== 'complete' ? ` <span class="tag moved-tag" title="Rescheduled">moved from ${esc(when(g.moved_from))}</span>` : ''}${Object.keys(g.theme || {}).length ? ' <span class="tag">custom</span>' : ''}</td>
    <td class="score-cell">${x.res ?? `${g.home_score}–${g.away_score}`}</td><td><span class="tag status-badge ${esc(g.status)}" data-status="${esc(g.status)}">${STATUS[g.status] || esc(g.status)}</span></td>
    <td class="right">${g.status === 'scheduled' ? `<button class="primary sm" data-start="${g.id}">Start on court</button>`
      : g.status === 'active' ? `<button class="sm" data-complete="${g.id}">Complete</button>` : `<button class="link sm" data-reopen="${g.id}">Reopen</button>`}
    ${g.status === 'scheduled' ? `<button class="link sm" data-resched="${g.id}">Reschedule…</button>` : ''}<button class="link sm" data-history="${g.id}">History</button>
    <button class="link sm" data-edit-game="${g.id}">Edit</button><button class="link sm" data-del-game="${g.id}">Delete</button></td></tr>`;
}

/** Today list row: result inline (complete: final score home first + FINAL [+ TIE]; active: live score + LIVE). */
function todayRow(g) {
  const r = resultOf(g);
  const res = r.kind === 'live' ? `<b class="result-score">${r.score}</b> <span class="tag live result-tag">● LIVE</span>`
    : r.kind ? `<b class="result-score">${r.score}</b> <span class="tag final result-tag">✓ FINAL</span>${r.kind === 'tie' ? ' <span class="tag final tie result-tag">TIE</span>' : ''}`
    : `${g.home_score}–${g.away_score}`;
  return gameRow(g, { res, cls: 'today-row', data: `data-status="${esc(g.status)}" data-result="${r.kind}" data-game-id="${g.id}"${r.winner ? ` data-winner="${r.winner}"` : ''}` });
}
const leagueDate = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: leagueTz });
const leagueHM = (iso) => new Date(iso).toLocaleTimeString('sv-SE', { timeZone: leagueTz, hour: '2-digit', minute: '2-digit' });
const hourOf = (hm) => `${hm.slice(0, 2)}:00`;
const ampm = (hm) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
/** Slot editor default: today if it has games, else the next day with games, else today. */
function defaultSlotDate() {
  const today = leagueDate(Date.now());
  const days = [...new Set(games.filter((g) => g.scheduled_at).map((g) => leagueDate(g.scheduled_at)))].sort();
  return days.includes(today) ? today : days.find((d) => d > today) || today;
}

/** Cheer squads table (Cheer tab). */
function renderSquads() {
  $('#squad-rows').innerHTML = squads.map((q) => `<tr data-squad-id="${q.id}"><td>${q.has_logo || q.logo_url ? `<img class="mini" src="${q.has_logo ? `/logos/squad/${q.id}?v=${Date.now()}` : esc(q.logo_url)}" alt="">` : ''}</td>
    <td>${esc(q.name)}</td><td>${q.coach ? `Coach ${esc(q.coach)}` : '<span class="muted">—</span>'}</td><td>${q.slots}</td>
    <td class="right"><button class="link sm" data-edit-squad="${q.id}">Edit</button><button class="link sm" data-del-squad="${q.id}">Delete</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">No cheer squads yet</td></tr>';
}
/**
 * Cheer-by-hour editor for slotDate: one row per hour that has games (plus hours that already have a slot).
 * A2: rebuilt only on load when nothing is being edited (slotsDirty / focus inside), so the 10 s refresh keeps edits.
 */
function renderSlots(force = false) {
  const box = $('#slot-rows');
  if (!force && (slotsDirty || box.contains(document.activeElement))) return;
  slotsDirty = false;
  $('#slot-date').value = slotDate;
  const day = games.filter((g) => g.scheduled_at && leagueDate(g.scheduled_at) === slotDate);
  const hours = [...new Set([...day.map((g) => hourOf(leagueHM(g.scheduled_at))), ...slots.map((x) => x.time)])].sort();
  const opts = (sel) => `<option value="">— none —</option>` + squads.map((q) => `<option value="${q.id}"${q.id === sel ? ' selected' : ''}>${esc(q.name)}</option>`).join('');
  box.innerHTML = hours.map((h) => {
    const sl = slots.find((x) => x.time === h), gs = day.filter((g) => hourOf(leagueHM(g.scheduled_at)) === h);
    return `<tr data-slot-hour="${h}"${sl ? ` data-slot-id="${sl.id}"` : ''}><td class="when">${ampm(h)}</td>
      <td>${gs.map((g) => `${esc(g.court || '—')} ${leagueHM(g.scheduled_at)} ${esc(g.label || g.grade || '')}`).join('<br>') || '<span class="muted">no games this hour</span>'}</td>
      <td><select name="squad_id" aria-label="Cheer squad at ${ampm(h)}">${opts(sl?.squad_id)}</select></td>
      <td><input name="locker" maxlength="8" value="${esc(sl?.locker ?? '')}" aria-label="Cheer locker room at ${ampm(h)}" placeholder="1"></td>
      <td class="right"><button class="primary sm" data-save-slot="${h}">Save</button></td></tr>`;
  }).join('') || `<tr><td colspan="5" class="muted">No games on ${esc(slotDate)}</td></tr>`;
}
/** Warnings that aren't tied to a game (cheer-slot-empty, cheer-slot-conflict); a conflict offers "pick this squad". */
function renderSlotWarnings() {
  const ws = warnings.filter((w) => w.gameId == null);
  for (const box of document.querySelectorAll('[data-slot-warnings]')) {
    box.hidden = !ws.length;
    box.innerHTML = ws.length ? `<b>⚠ ${ws.length} cheer slot warning${ws.length === 1 ? '' : 's'}</b><ul>${ws.map((w) => `<li data-code="${esc(w.code)}">${esc(w.message)}${
      w.code === 'cheer-slot-conflict' ? ` ${(w.candidates || []).map((c) => `<button class="sm" data-pick-squad="${esc(c)}" data-date="${esc(w.slot.date)}" data-time="${esc(w.slot.start)}">Pick ${esc(c)}</button>`).join(' ')}` : ''}</li>`).join('')}</ul>` : '';
  }
}
/** The live parts of the page (court cards, Today list, all-games table): safe to re-render on every push. */
function renderLive() {
  $('#court-cards').innerHTML = courts.map((c) => {
    const g = games.find((x) => x.court_id === c.id && x.status === 'active');
    const s = encodeURIComponent(c.slug);
    return `<div class="card"><h3>${esc(c.name)}</h3><p>${g ? `<b>${esc(g.home)} ${g.home_score} – ${g.away_score} ${esc(g.away)}</b> <span class="tag status-badge ${esc(g.status)}" data-status="${esc(g.status)}">${STATUS[g.status]}</span>` : '<span class="muted">No active game (TV shows Next up)</span>'}</p>
      <p class="links"><a href="${tvPath(c.slug)}" target="_blank">TV</a> · <a href="/score/${s}" target="_blank">Scorekeeper</a> · <a href="${tvPath(c.slug)}/overlay" target="_blank">Overlay</a></p></div>`;
  }).join('');
  // Bug A1: this used to drop complete games (filter status !== 'complete'), so a finished game vanished instead of
  // showing its result. Now: today's finals stay, with the result inline.
  $('#today-games').innerHTML = todayGames(games, courts, leagueDate(Date.now()), leagueDate).map(todayRow).join('') || '<tr><td colspan="6" class="muted">No games</td></tr>';
  const gf = $('#game-grade-filter').value;
  $('#game-rows').innerHTML = games.filter((g) => !gf || g.grade === gf).map((g) => gameRow({ ...g, __full: true })).join('') || '<tr><td colspan="7" class="muted">No games</td></tr>';
}

function render() {
  const opt = (arr, label) => arr.map((x) => `<option value="${x.id}">${esc(label(x))}</option>`).join('');
  renderLive();
  const tf = $('#team-grade-filter').value;
  // Grade filters + datalist (teams come sorted by grade, then name, from the server).
  const grades = [...new Set(teams.map((t) => t.grade).filter(Boolean))];
  for (const sel of document.querySelectorAll('[data-grade-filter]')) { const v = sel.value; sel.innerHTML = '<option value="">All grades</option>' + grades.map((g) => `<option>${esc(g)}</option>`).join(''); sel.value = grades.includes(v) ? v : ''; }
  $('#grade-list').innerHTML = grades.map((g) => `<option value="${esc(g)}">`).join('');
  renderTeams(tf);
  $('#court-rows').innerHTML = courts.map((c) => `<tr><td>${esc(c.name)}</td><td><code>${esc(c.slug)}</code></td><td>${c.has_pin ? '✔' : '<span class="bad">no PIN — scorekeeping disabled</span>'}</td>
    <td><a href="/tv/${esc(c.slug)}" target="_blank">TV</a> · <a href="/score/${esc(c.slug)}" target="_blank">Score</a> · <a href="/overlay/${esc(c.slug)}" target="_blank">Overlay</a></td>
    <td class="right"><button class="link sm" data-del-court="${c.id}">Delete</button></td></tr>`).join('');
  const f = $('#game-form');
  // A2: the 10 s refresh rebuilds these selects; keep what's selected (an edit in progress), defaults only when empty.
  const keep = Object.fromEntries(['court_id', 'home_team_id', 'away_team_id'].map((k) => [k, f.elements[k].value]));
  f.elements.court_id.innerHTML = opt(courts, (c) => c.name);
  f.elements.home_team_id.innerHTML = opt(teams, (t) => [t.grade, t.gender, t.name].filter(Boolean).join(' '));
  f.elements.away_team_id.innerHTML = opt(teams, (t) => [t.grade, t.gender, t.name].filter(Boolean).join(' '));
  for (const [k, v] of Object.entries(keep)) if (v && [...f.elements[k].options].some((o) => o.value === v)) f.elements[k].value = v;
  // Schedule warnings (not errors): team twice in a weekend, cheer squad rules, split-court hours.
  const warns = games.flatMap((g) => g.warnings || []), wbox = $('#schedule-warnings');
  wbox.hidden = !warns.length;
  wbox.innerHTML = warns.length ? `<b>⚠ ${warns.length} schedule warning${warns.length === 1 ? '' : 's'}</b><ul>${[...new Set(warns)].map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
  if (teams[1] && !keep.away_team_id) f.elements.away_team_id.value = teams[1].id;
  renderSquads(); renderSlots(); renderSlotWarnings();
}

document.addEventListener('click', guard(async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.start) {
    const url = `/api/games/${b.dataset.start}/start`;
    let r;
    try { r = await api(url, { method: 'POST' }); } catch (err) {
      // Shared floor: Full can't run while West/East is live (and vice versa). Admin may override.
      if (err.status !== 409 || !confirm(`${err.message}\n\nStart anyway?`)) throw err;
      r = await api(url, { method: 'POST', body: JSON.stringify({ force: true }) });
    }
    msg(`Game is now on ${r.court}. TV and scorekeeper update automatically.`); await load();
  }
  if (b.dataset.complete && confirm('Complete this game? The final score will be locked and the court goes to "Next up".')) {
    await api(`/api/games/${b.dataset.complete}/complete`, { method: 'POST' }); msg('Game completed. Final score locked.'); await load();
  }
  if (b.dataset.reopen && confirm('Reopen this game? It becomes the active game on its court again.')) {
    const url = `/api/games/${b.dataset.reopen}/reopen`;
    try { await api(url, { method: 'POST' }); } catch (err) {
      if (err.status !== 409 || !/shares the floor/.test(err.message) || !confirm(`${err.message}\n\nReopen anyway?`)) throw err;
      await api(url, { method: 'POST', body: JSON.stringify({ force: true }) });
    }
    msg('Game reopened.'); await load();
  }
  if (b.dataset.qrRegen && confirm('Make a new QR code for this court? Codes already printed for it stop working.')) { await api(`/api/courts/${b.dataset.qrRegen}/qr/regenerate`, { method: 'POST' }); await loadQr(); msg('New QR code made. Print it.'); }
  if (b.dataset.qrRevoke && confirm('Revoke this court\'s QR code? Printed codes stop working until you print a new one (the PIN still works).')) { await api(`/api/courts/${b.dataset.qrRevoke}/qr/revoke`, { method: 'POST' }); qrCards = qrCards.filter((q) => String(q.court_id) !== b.dataset.qrRevoke); renderQr(); msg('QR code revoked.'); }
  if (b.id === 'qr-show') await loadQr();
  if (b.id === 'qr-print') window.print();
  if (b.dataset.editGame) {
    const g = games.find((x) => x.id === Number(b.dataset.editGame)); const f = $('#game-form');
    f.reset();
    const el = f.elements;
    el.id.value = g.id; el.court_id.value = g.court_id ?? ''; el.division.value = g.division ?? '';
    el.scheduled_at.value = g.scheduled_at ? new Date(g.scheduled_at).toLocaleString('sv-SE', { timeZone: leagueTz }).slice(0, 16).replace(' ', 'T') : '';
    el.home_team_id.value = g.home_team_id; el.away_team_id.value = g.away_team_id; el.swap_colors.checked = !!g.swap_colors;
    for (const k of ['home_locker', 'away_locker']) el[k].value = g[k] ?? '';
    el.homeName.value = g.theme?.homeName ?? ''; el.awayName.value = g.theme?.awayName ?? '';
    $('#game-save').textContent = 'Save game'; f.scrollIntoView({ behavior: 'smooth' });
  }
  if (b.dataset.resched) openReschedule(games.find((x) => x.id === Number(b.dataset.resched)));
  if (b.dataset.history) await openHistory(Number(b.dataset.history));
  if (b.dataset.delGame && confirm('Delete this game?')) { await api(`/api/games/${b.dataset.delGame}`, { method: 'DELETE' }); await load(); }
  if (b.dataset.delTeam && confirm('Delete this team?')) { await api(`/api/teams/${b.dataset.delTeam}`, { method: 'DELETE' }); await load(); }
  if (b.dataset.delCourt && confirm('Delete this court?')) { await api(`/api/courts/${b.dataset.delCourt}`, { method: 'DELETE' }); await load(); }
  if (b.dataset.editSquad) {
    const q = squads.find((x) => x.id === Number(b.dataset.editSquad)); const f = $('#squad-form');
    for (const k of ['id', 'name', 'coach', 'logo_url']) f.elements[k].value = q[k] ?? '';
    $('#squad-save').textContent = 'Save squad'; f.scrollIntoView({ behavior: 'smooth' });
  }
  if (b.dataset.delSquad && confirm('Delete this cheer squad?')) { await api(`/api/cheer-squads/${b.dataset.delSquad}`, { method: 'DELETE' }); msg('Cheer squad deleted'); await load(); }
  if (b.dataset.saveSlot) {
    const tr = b.closest('tr'), sid = tr.dataset.slotId, squad = tr.querySelector('[name=squad_id]').value, locker = tr.querySelector('[name=locker]').value;
    if (!squad) { if (sid) await api(`/api/cheer-slots/${sid}`, { method: 'DELETE' }); }
    else if (sid) await api(`/api/cheer-slots/${sid}`, { method: 'PUT', body: JSON.stringify({ squad_id: Number(squad), locker }) });
    else await api('/api/cheer-slots', { method: 'POST', body: JSON.stringify({ date: slotDate, time: b.dataset.saveSlot, squad_id: Number(squad), locker }) });
    msg(`Cheer for ${ampm(b.dataset.saveSlot)} saved${squad ? '' : ' (no cheer that hour)'}. TVs update automatically.`);
    slotsDirty = false; document.activeElement?.blur(); await load(); renderSlots(true);
  }
  if (b.dataset.pickSquad) {
    await api('/api/cheer-slots/pick', { method: 'POST', body: JSON.stringify({ date: b.dataset.date, time: b.dataset.time, squad: b.dataset.pickSquad }) });
    msg(`${b.dataset.pickSquad} set for ${b.dataset.date} ${ampm(b.dataset.time)}.`); await load(); renderSlots(true);
  }
  if (b.dataset.editTeam) {
    const t = teams.find((x) => x.id === Number(b.dataset.editTeam)); const f = $('#team-form');
    for (const k of ['id', 'name', 'short_name', 'grade', 'gender', 'coach', 'logo_url']) f.elements[k].value = t[k] ?? '';
    $('#team-save').textContent = 'Save team'; f.scrollIntoView({ behavior: 'smooth' });
  }
}));

const fileToDataUrl = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(file); });

$('#team-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault(); const f = e.target;
  const body = Object.fromEntries(['name', 'short_name', 'grade', 'gender', 'coach', 'logo_url'].map((k) => [k, f.elements[k].value]));
  const file = f.elements.logo_file.files[0];
  if (file && file.size > 1024 * 1024) throw new Error(`Logo is ${(file.size / 1048576).toFixed(1)} MB; the limit is 1 MB. Please use a smaller image.`);
  if (file) body.logo_data_url = await fileToDataUrl(file);
  if (f.elements.id.value) await api(`/api/teams/${f.elements.id.value}`, { method: 'PUT', body: JSON.stringify(body) });
  else await api('/api/teams', { method: 'POST', body: JSON.stringify(body) });
  f.reset(); f.elements.id.value = ''; $('#team-save').textContent = 'Add team'; msg('Team saved'); await load();
}));
$('#team-form').addEventListener('reset', () => { $('#team-form').elements.id.value = ''; $('#team-save').textContent = 'Add team'; });

$('#court-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault(); const f = e.target;
  const r = await api('/api/courts', { method: 'POST', body: JSON.stringify({ name: f.elements.name.value, location: f.elements.location.value }) });
  f.reset(); msg(`Court added (slug ${r.slug}). Add a PIN for it in COURT_PINS.`); await load();
}));

// Hex color boxes: the text box (#RGB / #RRGGBB, any case) is what's saved; the native swatch next to it stays in sync.
const normHex = (v) => { const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || '').trim()); if (!m) return null; const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]; return '#' + h.toUpperCase(); };
function setHex(f, name, v) { const t = f.elements[name]; t.value = v ? (normHex(v) || v) : ''; t.dispatchEvent(new Event('input', { bubbles: true })); }
document.querySelectorAll('input[type=color][data-hex-for]').forEach((sw) => {
  const t = sw.form.elements[sw.dataset.hexFor];
  sw.addEventListener('input', () => { t.value = sw.value.toUpperCase(); t.dispatchEvent(new Event('input', { bubbles: true })); });
  t.addEventListener('input', () => {
    const h = normHex(t.value), empty = !t.value.trim();
    t.setCustomValidity(h || empty ? '' : 'Use a hex color like #1E90FF (#RGB or #RRGGBB)');
    t.classList.toggle('bad', !h && !empty);
    if (h && sw.value.toUpperCase() !== h) sw.value = h.toLowerCase();
    const use = sw.form.elements['use' + sw.dataset.hexFor[0].toUpperCase() + sw.dataset.hexFor.slice(1)];
    if (use) use.checked = !!h; // typing/picking a color uses it; clearing it goes back to the season color
  });
  t.addEventListener('change', () => { const h = normHex(t.value); if (h) t.value = h; });
});

$('#game-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault(); const f = e.target; const el = f.elements;
  // Display names only: every game uses the season colors (per-game colors are retired).
  const theme = { homeName: el.homeName.value || undefined, awayName: el.awayName.value || undefined };
  const body = {
    court_id: Number(el.court_id.value), home_team_id: Number(el.home_team_id.value), away_team_id: Number(el.away_team_id.value),
    scheduled_at: el.scheduled_at.value || null /* naive local time, interpreted in league TZ by Postgres */, division: el.division.value, theme,
    swap_colors: el.swap_colors.checked,
    home_locker: el.home_locker.value, away_locker: el.away_locker.value, // per game; cheer is per time slot (Cheer tab)
  };
  const r = el.id.value ? await api(`/api/games/${el.id.value}`, { method: 'PUT', body: JSON.stringify(body) })
    : await api('/api/games', { method: 'POST', body: JSON.stringify(body) });
  const wasEdit = !!el.id.value; f.reset();
  msg(`${wasEdit ? 'Game saved' : 'Game added'}${r.warnings?.length ? ` · ⚠ warning: ${r.warnings.join('; ')}` : ''}`, !!r.warnings?.length); await load();
}));
$('#game-form').addEventListener('reset', () => { $('#game-form').elements.id.value = ''; $('#game-save').textContent = 'Add game';
  setTimeout(() => { const el = $('#game-form').elements; if (teams[1] && !el.id.value) el.away_team_id.value = teams[1].id; }); }); // fresh-form default (not when Edit just filled it)

$('#squad-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault(); const f = e.target;
  const body = Object.fromEntries(['name', 'coach', 'logo_url'].map((k) => [k, f.elements[k].value]));
  const file = f.elements.logo_file.files[0];
  if (file && file.size > 1024 * 1024) throw new Error(`Logo is ${(file.size / 1048576).toFixed(1)} MB; the limit is 1 MB. Please use a smaller image.`);
  if (file) body.logo_data_url = await fileToDataUrl(file);
  if (f.elements.id.value) await api(`/api/cheer-squads/${f.elements.id.value}`, { method: 'PUT', body: JSON.stringify(body) });
  else await api('/api/cheer-squads', { method: 'POST', body: JSON.stringify(body) });
  f.reset(); f.elements.id.value = ''; $('#squad-save').textContent = 'Add squad'; msg('Cheer squad saved'); await load(); renderSlots(true);
}));
$('#squad-form').addEventListener('reset', () => { $('#squad-form').elements.id.value = ''; $('#squad-save').textContent = 'Add squad'; });
$('#slot-date').addEventListener('change', guard(async (e) => {
  if (!e.target.value) return;
  slotDate = e.target.value; slotsDirty = false; slots = await api(`/api/cheer-slots?date=${slotDate}`); renderSlots(true);
}));
$('#slot-rows').addEventListener('input', () => { slotsDirty = true; });
$('#slot-rows').addEventListener('change', () => { slotsDirty = true; });

// Season colors: one dark + one light for every team. Checked here with Sage's window.Contrast helpers.
function seasonCheck() {
  const f = $('#season-form'), box = $('#season-contrast'), C = window.Contrast; if (!C) return;
  const d = normHex(f.elements.dark.value), l = normHex(f.elements.light.value), rows = [];
  if (!d || !l) { box.innerHTML = '<div class="cw-row">⚠ Enter both colors as hex, like #800000 or #FC2.</div>'; box.hidden = false; box.classList.add('bad'); return; }
  // Text on each color is picked automatically (black or white, whichever reads better: always >= 4.5:1).
  const best = (bg) => Math.max(C.ratio('#000000', bg), C.ratio('#ffffff', bg)), dvl = C.ratio(d, l);
  const tw = (bg) => (C.ratio('#000000', bg) >= C.ratio('#ffffff', bg) ? 'black' : 'white');
  rows.push(`Text on dark (auto ${tw(d)}): ${C.fmt(best(d))} ✔`);
  rows.push(`Text on light (auto ${tw(l)}): ${C.fmt(best(l))} ✔`);
  if (dvl < 1.5) rows.push(`⚠ Dark vs light only ${C.fmt(dvl)} (under 1.5:1): home and away will look almost the same. You can still save.`);
  else rows.push(`Dark vs light (side by side): ${C.fmt(dvl)} ${dvl >= 3 ? '✔' : 'ℹ fairly close'}`);
  if (C.luminance(d) >= C.luminance(l)) rows.push('⚠ The dark color must be darker than the light color.');
  // Cheer colors have no dark-before-light rule. A bad hex is a warning; a good one shows its auto text color.
  // The swatch sample uses that same black/white pick (--sample-fg). Practice cards draw the color on black,
  // or white when it would be under 4.5:1 (onDarkFor). Nearly-equal cheer colors make the cards look the same.
  const cheerLine = (label, el) => {
    const h = normHex(el.value), swatch = el.closest('.season-swatch');
    if (!h) { rows.push(`⚠ ${label}: enter a hex color like #FF00AA or #FC2.`); if (swatch) swatch.style.removeProperty('--sample-fg'); return; }
    rows.push(`Text on ${label} (auto ${tw(h)}): ${C.fmt(best(h))} ✔`);
    if (swatch) swatch.style.setProperty('--sample-fg', tw(h) === 'black' ? '#000' : '#fff');
    const onBlack = C.ratio(h, '#000000');
    if (onBlack < 4.5) rows.push(`ℹ Cheer ${label.replace(/^cheer /, '')} ${h} is only ${C.fmt(onBlack)} on the black practice cards — shown as white there.`);
  };
  cheerLine('cheer primary', f.elements.cheerPrimary);
  cheerLine('cheer secondary', f.elements.cheerSecondary);
  const cp = normHex(f.elements.cheerPrimary.value), cs = normHex(f.elements.cheerSecondary.value);
  if (cp && cs) { const pvs = C.ratio(cp, cs); if (pvs < 1.5) rows.push(`⚠ Cheer primary vs secondary only ${C.fmt(pvs)} — practice cards will look the same.`); }
  box.innerHTML = rows.map((r) => `<div class="cw-row">${esc(r)}</div>`).join(''); box.hidden = false;
  box.classList.toggle('bad', rows.some((r) => r.includes('⚠')));
}
$('#season-form').addEventListener('input', seasonCheck);
// P3: the season fields are prefilled from the server only while untouched; typing (a real user input) marks a field
// touched so a background reload (load() after any change) never overwrites what the user has started typing.
$('#season-form').addEventListener('input', (e) => { if (e.isTrusted && e.target.name) e.target.dataset.touched = '1'; });
$('#season-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault(); const f = e.target;
  const r = await api('/api/settings/season', { method: 'PUT', body: JSON.stringify({ name: f.elements.name.value, dark: f.elements.dark.value, light: f.elements.light.value, cheerPrimary: f.elements.cheerPrimary.value, cheerSecondary: f.elements.cheerSecondary.value }) });
  seasonColors = r.dark ? r : await api('/api/settings/season'); renderTeams();
  for (const el of f.elements) delete el.dataset.touched;
  const C = window.Contrast, dvl = C && r.dark ? C.ratio(r.dark, r.light) : 9;
  msg(`Season colors saved (${r.name}). TVs update automatically.` + (dvl < 1.5 ? ` ⚠ Warning: dark vs light is only ${C.fmt(dvl)} (under 1.5:1), home and away will look almost the same.` : ''));
}));
async function loadSeason() {
  const s = await api('/api/settings/season'); const f = $('#season-form');
  seasonColors = s; renderTeams();
  const fresh = (n) => !f.elements[n].dataset.touched;
  if (fresh('name')) f.elements.name.value = s.name;
  if (fresh('dark')) setHex(f, 'dark', s.dark);
  if (fresh('light')) setHex(f, 'light', s.light);
  if (fresh('cheerPrimary')) setHex(f, 'cheerPrimary', s.cheerPrimary);
  if (fresh('cheerSecondary')) setHex(f, 'cheerSecondary', s.cheerSecondary);
  seasonCheck();
}

for (const [id, path] of [['#import-teams', '/api/import/teams.csv'], ['#import-courts', '/api/import/courts.csv'], ['#import-schedule', '/api/import/schedule.csv'],
  ['#import-cheer-squads', '/api/import/cheer_squads.csv'], ['#import-cheer-slots', '/api/import/cheer_slots.csv']]) {
  $(id).addEventListener('change', guard(async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = await api(path, { method: 'POST', body: await file.text(), headers: { 'content-type': 'text/csv' } });
    msg(`${file.name}: ${r.created} created, ${r.updated} updated, ${r.skipped} unchanged/skipped${r.errors.length ? ` · ${r.errors.length} problem(s): ${r.errors.slice(0, 5).join('; ')}${r.errors.length > 5 ? '; …' : ''}` : ''}${r.warnings?.length ? ` · ⚠ ${r.warnings.length} warning(s): ${r.warnings.slice(0, 5).join('; ')}${r.warnings.length > 5 ? '; …' : ''}` : ''}`, r.errors.length > 0 || !!r.warnings?.length);
    e.target.value = ''; await load();
  }));
}

async function boot() { $('#app').hidden = false; route(); await load(); setInterval(() => !document.hidden && load().catch(() => {}), 10000); live(); }
/**
 * Live like the TVs: the same WebSocket push the lobby TV uses (role=schedule, every court). Every score,
 * load, complete, reopen, edit, import or delete pushes a snapshot (coalesced 150 ms server-side); we then refetch
 * /api/games and re-render only the live parts (forms keep what's being typed).
 */
let liveConn = null, liveTimer = null;
function live() {
  if (liveConn) return;
  liveConn = connect({
    court: '*', role: 'schedule',
    onState: (m) => { if (m.kind !== 'schedule') return; clearTimeout(liveTimer); liveTimer = setTimeout(refreshLive, 100); },
    onStatus: (st) => { document.documentElement.dataset.live = st; },
  });
}
async function refreshLive() {
  try { games = await api('/api/games'); renderLive(); } catch {}
  // Team / season color saves also push (refreshAllCourts): keep the team-list colors current in other tabs too.
  try { [teams, seasonColors] = await Promise.all([api('/api/teams'), api('/api/settings/season')]); renderTeams(); } catch {}
}
api('/api/me').then((me) => { leagueTz = me.tz; boot(); }).catch(() => {});

for (const sel of document.querySelectorAll('[data-grade-filter]')) sel.addEventListener('change', () => render());

// Weekly scorekeeper QR codes (Courts tab). Each code signs a phone in to one court until Sunday 23:59.
let qrCards = [];
async function loadQr() { qrCards = await api('/api/qr'); renderQr(); }
function renderQr() {
  const fmt = (iso) => new Date(iso).toLocaleString([], { timeZone: leagueTz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  $('#qr-cards').innerHTML = qrCards.map((q) => `<article class="qr-card" data-court="${esc(q.slug)}">
    <h3 class="qr-court">${esc(q.name)} Court</h3>
    <div class="qr-code">${q.svg /* SVG generated by the server's QR library from our own URL */}</div>
    <p class="qr-help">Scorekeeper: scan with the phone camera.</p>
    <p class="qr-expires">Valid until ${esc(fmt(q.expires))}</p>
    <p class="qr-url"><code>${esc(q.url.replace(/\?t=.*/, '?t=…'))}</code></p>
    <p class="qr-actions no-print"><button class="link sm" data-qr-regen="${q.court_id}">New code</button><button class="link sm" data-qr-revoke="${q.court_id}">Revoke</button></p>
  </article>`).join('');
  $('#qr-panel').hidden = false;
}

// ---- Reschedule (docs/plans/reschedule-games.md): new date + tip-off only; court and lockers stay. Dry-run preview. ----
const rsDlg = () => $('#resched-dlg');
let rsGame = null, rsSeq = 0;
function openReschedule(g) {
  if (!g) return;
  rsGame = g; const f = $('#resched-form');
  f.date.value = leagueDate(g.scheduled_at || Date.now());
  f.time.value = g.scheduled_at ? leagueHM(g.scheduled_at) : ''; // pre-filled with the current tip-off
  f.reason.value = '';
  $('#resched-title').textContent = `Reschedule: ${g.home} vs ${g.away}`;
  $('#resched-now').textContent = `Now: ${when(g.scheduled_at)} · ${g.court || 'no court'} (court and locker rooms stay the same)`;
  rsDlg().showModal(); reschedPreview();
}
const rsBody = () => { const f = $('#resched-form'); return { date: f.date.value, time: f.time.value, reason: f.reason.value }; };
async function reschedPreview() {
  const seq = ++rsSeq, out = $('#resched-preview'), save = $('#resched-save');
  save.disabled = true;
  let r;
  try { r = await api(`/api/games/${rsGame.id}/reschedule`, { method: 'POST', body: JSON.stringify({ ...rsBody(), dryRun: true }) }); }
  catch (e) { r = e.body && typeof e.body === 'object' ? { ...e.body, errors: e.body.errors || [e.message] } : { errors: [e.message] }; }
  if (seq !== rsSeq) return;
  const p = r.preview, cheer = (x) => (x ? esc(x) : 'no cheer');
  out.innerHTML = (p ? `<p>Cheer at the old hour (${esc(p.from?.label || '—')}): <b>${cheer(p.from?.cheer)}</b><br>Cheer at the new hour (${esc(p.to.label)}): <b>${cheer(p.to.cheer)}</b>
    <br><small>Cheer is per hour and shared by both courts, so it does not move with the game.</small></p>` : '')
    + ((r.errors || []).length ? `<ul class="errors" data-bind="conflicts">${r.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="ok" data-bind="conflicts">No conflicts.</p>');
  save.disabled = !!(r.errors || []).length;
}
$('#resched-form')?.addEventListener('input', () => reschedPreview());
$('#resched-cancel')?.addEventListener('click', () => rsDlg().close());
$('#resched-form')?.addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  try { await api(`/api/games/${rsGame.id}/reschedule`, { method: 'POST', body: JSON.stringify(rsBody()) }); }
  catch (err) { await reschedPreview(); throw err; }
  rsDlg().close(); msg('Game rescheduled. The lobby shows "Moved from …" until it is final.'); await load();
}));
async function openHistory(id) {
  const rows = await api(`/api/games/${id}/changes`);
  const f = (x) => (x?.date ? `${x.date} ${x.time}` : '—');
  $('#history-list').innerHTML = rows.length ? rows.map((r) => `<li>${esc(when(r.at))} · ${esc(r.actor || '')}: ${esc(r.kind)} ${esc(f(r.before))} → <b>${esc(f(r.after))}</b>${r.reason ? ` · “${esc(r.reason)}”` : ''}</li>`).join('') : '<li>No changes recorded.</li>';
  $('#history-dlg').showModal();
}
$('#history-close')?.addEventListener('click', () => $('#history-dlg').close());

// Season colors live in other admin tabs too (season.js role=season socket): team-list swatches follow without a reload.
window.addEventListener('season', (e) => { if (!seasonColors) return; seasonColors = { ...seasonColors, ...e.detail }; try { renderTeams(); } catch {} });
