// Admin logic: CRUD via REST, no framework. Styles live in admin.css.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let teams = [], courts = [], games = [];
let leagueTz; // all times shown in the league time zone (server TZ), not the viewer's

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const body = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error('login required'); }
  if (r.status === 413 && typeof body !== 'object') throw new Error('Upload too large. Logos must be 1 MB or smaller.');
  if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { status: r.status });
  return body;
}
function msg(t, bad = false) { const m = $('#msg'); m.textContent = t; m.className = 'msg ' + (bad ? 'bad' : 'ok'); clearTimeout(msg.t); msg.t = setTimeout(() => (m.textContent = ''), bad ? 20000 : 5000); }
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'login required') msg(e.message, true); } };

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
const swatch = (t) => `<span class="swatch" style="background:${esc(t.primary_color)};border-color:${esc(t.secondary_color)}"></span>`;

async function load() {
  [teams, courts, games] = await Promise.all([api('/api/teams'), api('/api/courts'), api('/api/games')]);
  loadSeason().catch(() => {});
  render();
}

function gameRow(g) {
  return `<tr class="${g.on_court ? 'live' : ''}" data-grade="${esc(g.grade || '')}"><td>${when(g.scheduled_at)}</td><td>${esc(g.court || '—')}</td>${g.__full ? `<td>${esc(g.grade || '—')}</td>` : ''}
    <td>${!g.__full && g.grade ? `${esc(g.grade)} · ` : ''}${esc(g.home)} vs ${esc(g.away)}${Object.keys(g.theme || {}).length ? ' <span class="tag">custom</span>' : ''}</td>
    <td>${g.home_score}–${g.away_score}</td><td><span class="tag ${g.status}">${g.on_court ? 'ON COURT' : esc(g.status)}</span></td>
    <td class="right"><button class="primary sm" data-start="${g.id}">${g.on_court ? 'Re-show' : 'Start on court'}</button>
    <button class="link sm" data-edit-game="${g.id}">Edit</button><button class="link sm" data-del-game="${g.id}">Delete</button></td></tr>`;
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
  const gf = $('#game-grade-filter').value, tf = $('#team-grade-filter').value;
  $('#game-rows').innerHTML = games.filter((g) => !gf || g.grade === gf).map((g) => gameRow({ ...g, __full: true })).join('') || '<tr><td colspan="7" class="muted">No games</td></tr>';
  // Grade filters + datalist (teams come sorted by grade, then name, from the server).
  const grades = [...new Set(teams.map((t) => t.grade).filter(Boolean))];
  for (const sel of document.querySelectorAll('[data-grade-filter]')) { const v = sel.value; sel.innerHTML = '<option value="">All grades</option>' + grades.map((g) => `<option>${esc(g)}</option>`).join(''); sel.value = grades.includes(v) ? v : ''; }
  $('#grade-list').innerHTML = grades.map((g) => `<option value="${esc(g)}">`).join('');
  $('#team-rows').innerHTML = teams.filter((t) => !tf || t.grade === tf).map((t) => `<tr><td>${t.has_logo || t.logo_url ? `<img class="mini" src="${t.has_logo ? `/logos/${t.id}?v=${Date.now()}` : esc(t.logo_url)}" alt="">` : swatch(t)}</td>
    <td>${esc(t.grade || '—')}</td><td>${esc(t.name)}</td><td>${esc(t.short_name)}</td>
    <td class="right"><button class="link sm" data-edit-team="${t.id}">Edit</button><button class="link sm" data-del-team="${t.id}">Delete</button></td></tr>`).join('');
  $('#court-rows').innerHTML = courts.map((c) => `<tr><td>${esc(c.name)}</td><td><code>${esc(c.slug)}</code></td><td>${c.has_pin ? '✔' : '<span class="bad">no PIN — scorekeeping disabled</span>'}</td>
    <td><a href="/tv/${esc(c.slug)}" target="_blank">TV</a> · <a href="/score/${esc(c.slug)}" target="_blank">Score</a> · <a href="/overlay/${esc(c.slug)}" target="_blank">Overlay</a></td>
    <td class="right"><button class="link sm" data-del-court="${c.id}">Delete</button></td></tr>`).join('');
  const f = $('#game-form');
  f.elements.court_id.innerHTML = opt(courts, (c) => c.name);
  f.elements.home_team_id.innerHTML = opt(teams, (t) => [t.grade, t.name].filter(Boolean).join(' '));
  f.elements.away_team_id.innerHTML = opt(teams, (t) => [t.grade, t.name].filter(Boolean).join(' '));
  if (teams[1]) f.elements.away_team_id.value = teams[1].id;
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
  if (b.dataset.editGame) {
    const g = games.find((x) => x.id === Number(b.dataset.editGame)); const f = $('#game-form');
    f.reset();
    const el = f.elements;
    el.id.value = g.id; el.court_id.value = g.court_id ?? ''; el.division.value = g.division ?? '';
    el.scheduled_at.value = g.scheduled_at ? new Date(g.scheduled_at).toLocaleString('sv-SE', { timeZone: leagueTz }).slice(0, 16).replace(' ', 'T') : '';
    el.home_team_id.value = g.home_team_id; el.away_team_id.value = g.away_team_id; el.swap_colors.checked = !!g.swap_colors;
    for (const k of ['home_cheer', 'away_cheer', 'home_cheer_logo_url', 'away_cheer_logo_url']) el[k].value = g[k] ?? '';
    el.homeName.value = g.theme?.homeName ?? ''; el.awayName.value = g.theme?.awayName ?? '';
    $('#game-save').textContent = 'Save game'; f.scrollIntoView({ behavior: 'smooth' });
  }
  if (b.dataset.delGame && confirm('Delete this game?')) { await api(`/api/games/${b.dataset.delGame}`, { method: 'DELETE' }); await load(); }
  if (b.dataset.delTeam && confirm('Delete this team?')) { await api(`/api/teams/${b.dataset.delTeam}`, { method: 'DELETE' }); await load(); }
  if (b.dataset.delCourt && confirm('Delete this court?')) { await api(`/api/courts/${b.dataset.delCourt}`, { method: 'DELETE' }); await load(); }
  if (b.dataset.editTeam) {
    const t = teams.find((x) => x.id === Number(b.dataset.editTeam)); const f = $('#team-form');
    for (const k of ['id', 'name', 'short_name', 'grade', 'logo_url']) f.elements[k].value = t[k] ?? '';
    $('#team-save').textContent = 'Save team'; f.scrollIntoView({ behavior: 'smooth' });
  }
}));

const fileToDataUrl = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(file); });

$('#team-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault(); const f = e.target;
  const body = Object.fromEntries(['name', 'short_name', 'grade', 'logo_url'].map((k) => [k, f.elements[k].value]));
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

$('#game-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault(); const f = e.target; const el = f.elements;
  const theme = { homeName: el.homeName.value || undefined, awayName: el.awayName.value || undefined };
  if (el.useHomeColor.checked) theme.homeColor = el.homeColor.value;
  if (el.useAwayColor.checked) theme.awayColor = el.awayColor.value;
  const body = {
    court_id: Number(el.court_id.value), home_team_id: Number(el.home_team_id.value), away_team_id: Number(el.away_team_id.value),
    scheduled_at: el.scheduled_at.value || null /* naive local time, interpreted in league TZ by Postgres */, division: el.division.value, theme,
    swap_colors: el.swap_colors.checked,
    home_cheer: el.home_cheer.value, away_cheer: el.away_cheer.value, home_cheer_logo_url: el.home_cheer_logo_url.value, away_cheer_logo_url: el.away_cheer_logo_url.value,
  };
  for (const side of ['home', 'away']) {
    const file = el[`${side}_cheer_logo_file`].files[0];
    if (file && file.size > 1024 * 1024) throw new Error(`${side === 'home' ? 'Home' : 'Away'} cheer logo is ${(file.size / 1048576).toFixed(1)} MB; the limit is 1 MB.`);
    if (file) body[`${side}_cheer_logo_data_url`] = await fileToDataUrl(file);
  }
  if (el.id.value) await api(`/api/games/${el.id.value}`, { method: 'PUT', body: JSON.stringify(body) });
  else await api('/api/games', { method: 'POST', body: JSON.stringify(body) });
  const wasEdit = !!el.id.value; f.reset(); msg(wasEdit ? 'Game saved' : 'Game added'); await load();
}));
$('#game-form').addEventListener('reset', () => { $('#game-form').elements.id.value = ''; $('#game-save').textContent = 'Add game'; });

// Season colors: one dark + one light for every team. Checked here with Sage's window.Contrast helpers.
function seasonCheck() {
  const f = $('#season-form'), box = $('#season-contrast'), C = window.Contrast; if (!C) return;
  const d = f.elements.dark.value, l = f.elements.light.value, rows = [];
  const wd = C.ratio('#ffffff', d), dl = C.ratio(C.DARK, l), dvl = C.ratio(d, l);
  rows.push(`White text on dark: ${C.fmt(wd)} ${wd >= 4.5 ? '✔' : '⚠ below 4.5:1'}`);
  rows.push(`Dark text on light: ${C.fmt(dl)} ${dl >= 4.5 ? '✔' : '⚠ below 4.5:1'}`);
  rows.push(`Dark vs light (side by side): ${C.fmt(dvl)} ${dvl >= 3 ? '✔' : '⚠ hard to tell apart'}`);
  if (C.luminance(d) >= C.luminance(l)) rows.push('⚠ The dark color must be darker than the light color.');
  box.innerHTML = rows.map((r) => `<div class="cw-row">${esc(r)}</div>`).join(''); box.hidden = false;
  box.classList.toggle('bad', rows.some((r) => r.includes('⚠')));
}
$('#season-form').addEventListener('input', seasonCheck);
$('#season-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault(); const f = e.target;
  const r = await api('/api/settings/season', { method: 'PUT', body: JSON.stringify({ name: f.elements.name.value, dark: f.elements.dark.value, light: f.elements.light.value }) });
  msg(`Season colors saved (${r.name}). TVs update automatically.`);
}));
async function loadSeason() {
  const s = await api('/api/settings/season'); const f = $('#season-form');
  f.elements.name.value = s.name; f.elements.dark.value = s.dark; f.elements.light.value = s.light; seasonCheck();
}

for (const [id, path] of [['#import-teams', '/api/import/teams.csv'], ['#import-courts', '/api/import/courts.csv'], ['#import-schedule', '/api/import/schedule.csv']]) {
  $(id).addEventListener('change', guard(async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = await api(path, { method: 'POST', body: await file.text(), headers: { 'content-type': 'text/csv' } });
    msg(`${file.name}: ${r.created} created, ${r.updated} updated, ${r.skipped} unchanged/skipped${r.errors.length ? ` · ${r.errors.length} problem(s): ${r.errors.slice(0, 5).join('; ')}${r.errors.length > 5 ? '; …' : ''}` : ''}`, r.errors.length > 0);
    e.target.value = ''; await load();
  }));
}

async function boot() { $('#app').hidden = false; route(); await load(); setInterval(() => !document.hidden && load().catch(() => {}), 10000); }
api('/api/me').then((me) => { leagueTz = me.tz; boot(); }).catch(() => {});

for (const sel of document.querySelectorAll('[data-grade-filter]')) sel.addEventListener('change', () => render());
