// Admin logic: CRUD via REST, no framework. Styles live in admin.css.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let teams = [], courts = [], games = [];

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const body = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error('login required'); }
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}
function msg(t, bad = false) { const m = $('#msg'); m.textContent = t; m.className = 'msg ' + (bad ? 'bad' : 'ok'); clearTimeout(msg.t); msg.t = setTimeout(() => (m.textContent = ''), 5000); }
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'login required') msg(e.message, true); } };

function showLogin() { $('#app').hidden = true; $('#login').hidden = false; }
$('#login').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); }
  catch (err) { $('#login-err').textContent = err.message; return; }
  $('#login').hidden = true; boot();
}));
$('#logout').addEventListener('click', async () => { await fetch('/api/logout'); showLogin(); });

function route() {
  const id = (location.hash || '#today').slice(1);
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== id));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.getAttribute('href') === '#' + id));
}
window.addEventListener('hashchange', route);

const when = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const swatch = (t) => `<span class="swatch" style="background:${esc(t.primary_color)};border-color:${esc(t.secondary_color)}"></span>`;

async function load() {
  [teams, courts, games] = await Promise.all([api('/api/teams'), api('/api/courts'), api('/api/games')]);
  render();
}

function gameRow(g) {
  return `<tr class="${g.on_court ? 'live' : ''}"><td>${when(g.scheduled_at)}</td><td>${esc(g.court || '—')}</td>
    <td>${esc(g.home)} vs ${esc(g.away)}${Object.keys(g.theme || {}).length ? ' <span class="tag">custom</span>' : ''}</td>
    <td>${g.home_score}–${g.away_score}</td><td><span class="tag ${g.status}">${g.on_court ? 'ON COURT' : esc(g.status)}</span></td>
    <td class="right"><button class="primary sm" data-start="${g.id}">${g.on_court ? 'Re-show' : 'Start on court'}</button>
    <button class="link sm" data-del-game="${g.id}">Delete</button></td></tr>`;
}

function render() {
  const opt = (arr, label) => arr.map((x) => `<option value="${x.id}">${esc(label(x))}</option>`).join('');
  $('#court-cards').innerHTML = courts.map((c) => {
    const g = games.find((x) => x.id === c.current_game_id);
    const s = encodeURIComponent(c.slug);
    return `<div class="card"><h3>${esc(c.name)}</h3><p>${g ? `<b>${esc(g.home)} ${g.home_score} – ${g.away_score} ${esc(g.away)}</b> <span class="tag ${g.status}">${esc(g.status)}</span>` : '<span class="muted">No game on court</span>'}</p>
      <p class="links"><a href="/tv/${s}" target="_blank">TV</a> · <a href="/score/${s}" target="_blank">Scorekeeper</a> · <a href="/overlay/${s}" target="_blank">Overlay</a></p></div>`;
  }).join('');
  $('#today-games').innerHTML = games.filter((g) => g.status !== 'final' || g.on_court).map(gameRow).join('') || '<tr><td colspan="6" class="muted">No games</td></tr>';
  $('#game-rows').innerHTML = games.map(gameRow).join('');
  $('#team-rows').innerHTML = teams.map((t) => `<tr><td>${t.has_logo || t.logo_url ? `<img class="mini" src="${t.has_logo ? `/logos/${t.id}?v=${Date.now()}` : esc(t.logo_url)}" alt="">` : swatch(t)}</td>
    <td>${esc(t.name)}</td><td>${esc(t.short_name)}</td><td>${swatch(t)} ${esc(t.primary_color)} / ${esc(t.secondary_color)}</td>
    <td class="right"><button class="link sm" data-edit-team="${t.id}">Edit</button><button class="link sm" data-del-team="${t.id}">Delete</button></td></tr>`).join('');
  $('#court-rows').innerHTML = courts.map((c) => `<tr><td>${esc(c.name)}</td><td><code>${esc(c.slug)}</code></td><td>${c.has_pin ? '✔' : '<span class="bad">no PIN — scorekeeping disabled</span>'}</td>
    <td><a href="/tv/${esc(c.slug)}" target="_blank">TV</a> · <a href="/score/${esc(c.slug)}" target="_blank">Score</a> · <a href="/overlay/${esc(c.slug)}" target="_blank">Overlay</a></td>
    <td class="right"><button class="link sm" data-del-court="${c.id}">Delete</button></td></tr>`).join('');
  const f = $('#game-form');
  f.elements.court_id.innerHTML = opt(courts, (c) => c.name);
  f.elements.home_team_id.innerHTML = opt(teams, (t) => t.name);
  f.elements.away_team_id.innerHTML = opt(teams, (t) => t.name);
  if (teams[1]) f.elements.away_team_id.value = teams[1].id;
}

document.addEventListener('click', guard(async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.start) { const r = await api(`/api/games/${b.dataset.start}/start`, { method: 'POST' }); msg(`Game is now on ${r.court}. TV and scorekeeper update automatically.`); await load(); }
  if (b.dataset.delGame && confirm('Delete this game?')) { await api(`/api/games/${b.dataset.delGame}`, { method: 'DELETE' }); await load(); }
  if (b.dataset.delTeam && confirm('Delete this team?')) { await api(`/api/teams/${b.dataset.delTeam}`, { method: 'DELETE' }); await load(); }
  if (b.dataset.delCourt && confirm('Delete this court?')) { await api(`/api/courts/${b.dataset.delCourt}`, { method: 'DELETE' }); await load(); }
  if (b.dataset.editTeam) {
    const t = teams.find((x) => x.id === Number(b.dataset.editTeam)); const f = $('#team-form');
    for (const k of ['id', 'name', 'short_name', 'primary_color', 'secondary_color', 'logo_url']) f.elements[k].value = t[k] ?? '';
    $('#team-save').textContent = 'Save team'; f.scrollIntoView({ behavior: 'smooth' });
  }
}));

const fileToDataUrl = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(file); });

$('#team-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault(); const f = e.target;
  const body = Object.fromEntries(['name', 'short_name', 'primary_color', 'secondary_color', 'logo_url'].map((k) => [k, f.elements[k].value]));
  if (f.elements.logo_file.files[0]) body.logo_data_url = await fileToDataUrl(f.elements.logo_file.files[0]);
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

$('#game-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault(); const f = e.target;
  const theme = { homeName: f.elements.homeName.value || undefined, awayName: f.elements.awayName.value || undefined };
  if (f.elements.useHomeColor.checked) theme.homeColor = f.elements.homeColor.value;
  if (f.elements.useAwayColor.checked) theme.awayColor = f.elements.awayColor.value;
  await api('/api/games', { method: 'POST', body: JSON.stringify({
    court_id: Number(f.elements.court_id.value), home_team_id: Number(f.elements.home_team_id.value), away_team_id: Number(f.elements.away_team_id.value),
    scheduled_at: f.elements.scheduled_at.value ? new Date(f.elements.scheduled_at.value).toISOString() : null, division: f.elements.division.value, theme }) });
  f.reset(); msg('Game added'); await load();
}));

for (const [id, path] of [['#import-teams', '/api/import/teams.csv'], ['#import-schedule', '/api/import/schedule.csv']]) {
  $(id).addEventListener('change', guard(async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = await api(path, { method: 'POST', body: await file.text(), headers: { 'content-type': 'text/csv' } });
    msg(`Imported ${r.upserted ?? r.created} rows${r.errors.length ? `; ${r.errors.length} errors: ${r.errors.slice(0, 3).join('; ')}` : ''}`, r.errors.length > 0);
    e.target.value = ''; await load();
  }));
}

async function boot() { $('#app').hidden = false; route(); await load(); setInterval(() => !document.hidden && load().catch(() => {}), 10000); }
api('/api/me').then(boot).catch(() => {});
