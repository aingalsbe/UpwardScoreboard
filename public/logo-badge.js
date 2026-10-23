// Mascot logo next to a team/squad name (lobby + practice TVs). Uses the logo URL the server already sends
// (bundled /team-logos/..., an upload /logos/<id> or /logos/squad/<id>, or an http(s) URL). No logo -> initial badge.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** First letter or digit of the name, uppercased ("  lady sparks" -> "L"); "?" when there is none. */
export const initialOf = (name) => (String(name ?? '').match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
/** Only same-origin paths ("/x", not "//x") or http(s) URLs are rendered as images. */
export const safeLogo = (url) => (typeof url === 'string' && (/^\/(?!\/)/.test(url) || /^https?:\/\//i.test(url)) ? url : null);
export function mascotHtml(url, name) {
  const u = safeLogo(url);
  return u ? `<img class="mascot" data-bind="logo" src="${esc(u)}" alt="" loading="lazy" decoding="async">`
    : `<span class="mascot badge" data-bind="logo" data-initial aria-hidden="true">${esc(initialOf(name))}</span>`;
}
