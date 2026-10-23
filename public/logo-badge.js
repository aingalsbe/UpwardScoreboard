// Mascot logo next to a team/squad name (lobby + practice TVs). Uses the logo URL the server already sends
// (bundled /team-logos/..., an upload /logos/<id> or /logos/squad/<id>, or an http(s) URL). No logo -> initial badge.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** First letter or digit of the name, uppercased ("  lady sparks" -> "L"); "?" when there is none. */
export const initialOf = (name) => (String(name ?? '').match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
/** Only same-origin paths ("/x", not "//x") or http(s) URLs are rendered as images. */
export const safeLogo = (url) => (typeof url === 'string' && (/^\/(?!\/)/.test(url) || /^https?:\/\//i.test(url)) ? url : null);
// Logos that failed to load (404, bad image): rendered as the initial badge from then on, so re-renders don't flicker.
const failed = new Set();
export const logoFailed = (url) => failed.has(url);
export function mascotHtml(url, name) {
  const u = safeLogo(url);
  return u && !failed.has(u) ? `<img class="mascot" data-bind="logo" src="${esc(u)}" alt="" data-initial="${esc(initialOf(name))}" decoding="async">`
    : `<span class="mascot badge" data-bind="logo" data-initial aria-hidden="true">${esc(initialOf(name))}</span>`;
}

/** Broken logo (404 etc.) -> swap the <img> for the initial badge (capturing 'error' listener; img errors don't bubble). */
export function onLogoError(e) {
  const t = e?.target;
  if (!t || t.tagName !== 'IMG' || !t.classList?.contains('mascot')) return false;
  failed.add(t.getAttribute('src'));
  const s = t.ownerDocument.createElement('span');
  s.className = 'mascot badge'; s.setAttribute('data-bind', 'logo'); s.setAttribute('data-initial', ''); s.setAttribute('aria-hidden', 'true');
  s.textContent = t.getAttribute('data-initial') || '?';
  t.replaceWith(s); return true;
}
export const installLogoFallback = (doc = document) => doc.addEventListener('error', onLogoError, true);

/** Court TV / overlay team logo: <img> in el, or the initial when there's no logo or it fails to load (404 etc.). */
export function fillTeamLogo(el, url, name) {
  if (!el) return;
  const u = safeLogo(url);
  const showInitial = () => { el.innerHTML = ''; el.textContent = initialOf(name); el.classList?.add('logo-initial'); };
  if (!u || failed.has(u)) { el.dataset.src = ''; showInitial(); return; }
  if (el.dataset.src === u) return;
  el.dataset.src = u; el.innerHTML = ''; el.classList?.remove('logo-initial');
  const img = el.ownerDocument.createElement('img');
  img.alt = '';
  img.onerror = () => { failed.add(u); if (el.dataset.src === u) { el.dataset.src = ''; showInitial(); } };
  img.src = u; el.appendChild(img);
}
/** Single image bind (church / cheer logo): shown when src loads, hidden when missing or broken. */
export function fillImg(el, url) {
  const u = safeLogo(url);
  if (!el.onerror) el.onerror = () => { const s = el.getAttribute('src'); if (s) failed.add(s); el.hidden = true; };
  if (!u || failed.has(u)) { el.removeAttribute('src'); el.hidden = true; return; }
  if (el.getAttribute('src') !== u) el.src = u;
  el.hidden = false;
}
