// Colors: stored and sent as uppercase #RRGGBB. Admin/API accept #RGB or #RRGGBB (any case); anything else is a 400.
// rgb()/rgba() only appear in old data and are converted by migrateColors() (db.ts) at startup.
const HEX_IN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
/** #RGB / #RRGGBB (any case, '#' required) -> '#RRGGBB'; else null. */
export function normHex(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s.startsWith('#')) return null;
  const m = HEX_IN.exec(s); if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return '#' + h.toUpperCase();
}
export const COLOR_HELP = 'use hex like #1E90FF (#RGB or #RRGGBB)';
/** Old stored values: hex (any case, 3/6 digits, '#' optional) or rgb()/rgba() -> '#RRGGBB'; else null. */
export function toHexLoose(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  const h = normHex(s.startsWith('#') ? s : '#' + s); if (h) return h;
  const m = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(s);
  if (!m) return null;
  const c = [m[1], m[2], m[3]].map(Number); if (c.some((x) => x > 255)) return null;
  return '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}
