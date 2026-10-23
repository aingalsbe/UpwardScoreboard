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

/** WCAG relative luminance of a #RRGGBB color. */
export function lumHex(h: string): number {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** Black or white text on h, whichever contrasts more (always >= ~4.5:1). */
export function fgFor(h: string): string { return lumHex(h) > 0.179 ? '#000000' : '#FFFFFF'; }
/** h itself when it reads >= 4.5:1 on black, otherwise white (season-colored text on black). */
export function onDarkFor(h: string): string { return (lumHex(h) + 0.05) / 0.05 >= 4.5 ? h : '#FFFFFF'; }

/**
 * The <style id="season-vars"> block injected into every HTML page. The first six variables stay in the
 * original order; cheer primary/secondary (and their -fg / -on-dark) follow. A value that isn't #RRGGBB
 * becomes #808080, same as the old seasonStyle() ok().
 */
export function seasonCss(s: { light?: unknown; dark?: unknown; cheerPrimary?: unknown; cheerSecondary?: unknown }): string {
  const ok = (h: unknown) => (typeof h === 'string' && /^#[0-9A-Fa-f]{6}$/.test(h) ? h : '#808080');
  const L = ok(s.light), D = ok(s.dark), P = ok(s.cheerPrimary), S = ok(s.cheerSecondary);
  return `<style id="season-vars">:root{--season-light:${L};--season-dark:${D};--season-light-fg:${fgFor(L)};--season-dark-fg:${fgFor(D)};--season-light-on-dark:${onDarkFor(L)};--season-dark-on-dark:${onDarkFor(D)};--season-cheer-primary:${P};--season-cheer-secondary:${S};--season-cheer-primary-fg:${fgFor(P)};--season-cheer-secondary-fg:${fgFor(S)};--season-cheer-primary-on-dark:${onDarkFor(P)};--season-cheer-secondary-on-dark:${onDarkFor(S)}}</style>`;
}
