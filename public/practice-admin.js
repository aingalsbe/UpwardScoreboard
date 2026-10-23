// Practice schedule editor (/admin/practice). Loads GET /api/practice, edits in memory, saves the whole week with
// PUT /api/practice (the server validates: court/room double-bookings and one court/room per team/squad all season).
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
const COURTS = [['west1', 'West 1'], ['west2', 'West 2'], ['east1', 'East 1'], ['east2', 'East 2']];
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const hm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const slots = (d) => { const o = []; if (!d) return o; for (let t = toMin(d.start); t + 60 <= toMin(d.end); t += 60) o.push(hm(t)); return o; };
let teams = [], squads = [], week = { days: [], basketball: [], cheer: [] }, cur = 1;

function msg(t, bad = false) { const m = $('#msg'); m.textContent = t; m.className = 'msg ' + (bad ? 'bad' : 'ok'); }
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json' } });
  const b = await r.json().catch(() => ({}));
  if (r.status === 401) { msg('Please log in on the Admin page first (link at the top), then reload.', true); throw new Error('login'); }
  if (!r.ok) throw Object.assign(new Error(b.error || r.statusText), { errors: b.errors });
  return b;
}
function fromServer(b) {
  teams = b.teams || teams; squads = b.squads || squads;
  week = { days: b.days.map((d) => ({ ...d })), basketball: b.basketball.map((x) => ({ day: x.day, start: x.start, court: x.court, teamId: x.teamId })),
    cheer: b.cheer.map((x) => ({ day: x.day, room: x.room, squadId: x.squadId })) };
}
const teamLabel = (t) => `${t.grade || ''} ${t.gender || ''} · ${t.name}${t.coach ? ' (Coach ' + t.coach + ')' : ''}`.trim();
function render() {
  $('.tabs').innerHTML = [1, 2, 3, 4].map((d) => `<button type="button" role="tab" data-day="${d}" aria-selected="${d === cur}">${DAYS[d]}</button>`).join('');
  $('#copyTo').innerHTML = [1, 2, 3, 4].filter((d) => d !== cur).map((d) => `<label><input type="checkbox" value="${d}"> ${DAYS[d].slice(0, 3)}</label>`).join(' ');
  const d = week.days.find((x) => x.day === cur);
  const dupTeam = new Set(), dupRoom = new Set();
  for (const s of slots(d)) { const seen = new Set(); for (const b of week.basketball.filter((x) => x.day === cur && x.start === s)) { if (seen.has(b.teamId)) dupTeam.add(s + b.teamId); seen.add(b.teamId); } }
  { const seen = new Set(); for (const c of week.cheer.filter((x) => x.day === cur)) { const k = c.room.trim().toLowerCase(); if (seen.has(k)) dupRoom.add(k); seen.add(k); } }
  const opt = (list, sel, label) => `<option value="">${esc(label)}</option>` + list.map((t) => `<option value="${t.id}"${t.id === sel ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
  const tl = teams.map((t) => ({ id: t.id, label: teamLabel(t) })), sl = squads.map((q) => ({ id: q.id, label: q.name + (q.coach ? ` (Coach ${q.coach})` : '') }));
  $('#day').innerHTML = `
  <h2>${DAYS[cur]}</h2>
  <p><label><input type="checkbox" id="on"${d ? ' checked' : ''}> Practice night</label>
  ${d ? `· Basketball hours <input type="time" id="start" value="${d.start}" step="1800"> to <input type="time" id="end" value="${d.end}" step="1800">` : ''}</p>
  ${d ? `<h3>Basketball (1-hour slots)</h3><table class="pa-grid"><tr><th>Time</th>${COURTS.map(([, n]) => `<th>${n}</th>`).join('')}</tr>
    ${slots(d).map((s) => `<tr><th>${s}</th>${COURTS.map(([c]) => { const b = week.basketball.find((x) => x.day === cur && x.start === s && x.court === c);
      return `<td class="${b && dupTeam.has(s + b.teamId) ? 'bad' : ''}"><select data-slot="${s}" data-court="${c}">${opt(tl, b?.teamId, 'Open')}</select></td>`; }).join('')}</tr>`).join('')}</table>
  <h3>Cheer (all evening)</h3><div class="pa-cheer">${week.cheer.map((c, i) => c.day !== cur ? '' : `<div class="${dupRoom.has(c.room.trim().toLowerCase()) ? 'bad' : ''}">
    <input data-room="${i}" value="${esc(c.room)}" maxlength="40" placeholder="Room (e.g. Room 28/30)"> <select data-squad="${i}">${opt(sl, c.squadId, 'Squad')}</select> <button type="button" data-del="${i}">Remove</button></div>`).join('')}
    <button type="button" id="addCheer">Add cheer room</button></div>` : ''}`;
}
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset.day) { cur = Number(t.dataset.day); render(); }
  if (t.dataset.del) { week.cheer.splice(Number(t.dataset.del), 1); render(); }
  if (t.id === 'addCheer') { week.cheer.push({ day: cur, room: '', squadId: 0 }); render(); }
  if (t.id === 'copy') {
    const to = [...document.querySelectorAll('#copyTo input:checked')].map((x) => Number(x.value));
    if (!to.length || !confirm(`Copy ${DAYS[cur]} to ${to.map((d) => DAYS[d]).join(', ')}? Their schedule is replaced.`)) return;
    const d = week.days.find((x) => x.day === cur);
    week.days = week.days.filter((x) => !to.includes(x.day)).concat(d ? to.map((day) => ({ ...d, day })) : []);
    week.basketball = week.basketball.filter((x) => !to.includes(x.day)).concat(...to.map((day) => week.basketball.filter((x) => x.day === cur).map((x) => ({ ...x, day }))));
    week.cheer = week.cheer.filter((x) => !to.includes(x.day)).concat(...to.map((day) => week.cheer.filter((x) => x.day === cur).map((x) => ({ ...x, day }))));
    msg('Copied. Change the teams for the other nights, then Save.'); render();
  }
  if (t.id === 'save') save();
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'on') { week.days = week.days.filter((x) => x.day !== cur); if (t.checked) week.days.push({ day: cur, start: '17:00', end: '21:00' });
    else { week.basketball = week.basketball.filter((x) => x.day !== cur); week.cheer = week.cheer.filter((x) => x.day !== cur); } render(); }
  if (t.id === 'start' || t.id === 'end') { const d = week.days.find((x) => x.day === cur); d[t.id] = t.value; render(); }
  if (t.dataset.court) { week.basketball = week.basketball.filter((x) => !(x.day === cur && x.start === t.dataset.slot && x.court === t.dataset.court));
    if (t.value) week.basketball.push({ day: cur, start: t.dataset.slot, court: t.dataset.court, teamId: Number(t.value) }); render(); }
  if (t.dataset.room) { week.cheer[Number(t.dataset.room)].room = t.value; render(); }
  if (t.dataset.squad) { week.cheer[Number(t.dataset.squad)].squadId = Number(t.value); render(); }
});
async function save() {
  $('#errors').innerHTML = '';
  // drop basketball slots that fell outside a night's changed hours
  week.basketball = week.basketball.filter((b) => slots(week.days.find((d) => d.day === b.day)).includes(b.start));
  try { fromServer({ teams, squads, ...(await api('/api/practice', { method: 'PUT', body: JSON.stringify(week) })) }); msg('Saved. The practice TVs update within a minute.'); render(); }
  catch (e) { if (e.message === 'login') return; msg('Not saved: fix the items below.', true); $('#errors').innerHTML = (e.errors || [e.message]).map((x) => `<li>${esc(x)}</li>`).join(''); }
}
api('/api/practice').then((b) => { fromServer(b); render(); }).catch(() => {});
