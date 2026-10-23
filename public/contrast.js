/* contrast.js (owned by Sage). Pure WCAG contrast helpers + a tiny observer.
   Devon's JS sets --home-color/--home-accent/--away-color/--away-accent on <html>;
   this file watches those and derives readable text colors as CSS variables:
     --{side}-fg        #fff or #111, whichever reads best ON the team color
     --{side}-logo-fg   accent if it reaches 4.5:1 on the team color, else --{side}-fg
     --{side}-on-dark   accent, lightened if needed to reach 4.5:1 on dark chrome
     --{side}-ring      outline color that separates the team color from dark chrome / white chips
   plus classes on <html>: {side}-light (team color is light), {side}-accent-fixed.
   No dependencies; also usable as window.Contrast in admin. */
(function () {
  'use strict';
  const DARK = '#111111', LIGHT = '#ffffff';
  function parse(c) {
    if (!c) return null;
    c = String(c).trim().toLowerCase();
    let m = c.match(/^#([0-9a-f]{3})$/);
    if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
    m = c.match(/^#([0-9a-f]{6})$/);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = c.match(/^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
    if (m) return [+m[1], +m[2], +m[3]];
    return null;
  }
  const hex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  function luminance(c) {
    const rgb = Array.isArray(c) ? c : parse(c);
    if (!rgb) return 0;
    const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function ratio(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  /** #fff or #111, whichever has the higher contrast on bg. */
  function bestText(bg) { return ratio(LIGHT, bg) >= ratio(DARK, bg) ? LIGHT : DARK; }
  /** Closest color to `color` (same hue, mixed toward black or white) reaching `target` on bg. */
  function suggest(color, bg, target = 4.5) {
    const c = parse(color); if (!c) return null;
    if (ratio(c, bg) >= target) return hex(c);
    const toward = luminance(bg) > 0.18 ? [0, 0, 0] : [255, 255, 255];
    const mix = (t) => c.map((v, i) => v + (toward[i] - v) * t);
    let lo = 0, hi = 1;
    if (ratio(mix(1), bg) < target) return null;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (ratio(mix(mid), bg) >= target) hi = mid; else lo = mid; }
    let out = mix(hi).map(Math.round);
    // rounding guard
    for (let i = 0; i < 20 && ratio(out, bg) < target; i++) out = out.map((v, k) => v + Math.sign(toward[k] - v));
    return hex(out);
  }
  const fmt = (r) => (Math.floor(r * 100) / 100).toFixed(2) + ':1';

  const Contrast = { parse, hex, luminance, ratio, bestText, suggest, fmt, DARK, LIGHT };
  window.Contrast = Contrast;

  // ---------------------------------------------------------------- display pages
  const page = document.body && (document.body.dataset.role || (document.querySelector('#pin-gate') ? 'score' : ''));
  if (!page || page === 'admin') return;
  // Darkest-to-lightest chrome behind accent-colored text (TV gradient top is #1b2340, controller panel #171c2e).
  const CHROME = '#1b2340';
  const root = document.documentElement;
  let last = '';
  function apply() {
    const cs = getComputedStyle(root);
    const vals = ['home', 'away'].map((s) => [cs.getPropertyValue(`--${s}-color`).trim(), cs.getPropertyValue(`--${s}-accent`).trim()]);
    const key = JSON.stringify(vals);
    if (key === last) return;
    last = key;
    ['home', 'away'].forEach((side, i) => {
      const [color, accent] = vals[i];
      if (!parse(color)) return;
      const fg = bestText(color);
      const acc = parse(accent) ? accent : fg;
      const logoFg = ratio(acc, color) >= 4.5 ? acc : fg;
      const onDark = suggest(acc, CHROME) || LIGHT;
      const light = luminance(color) > 0.18;
      root.style.setProperty(`--${side}-fg`, fg);
      root.style.setProperty(`--${side}-logo-fg`, logoFg);
      root.style.setProperty(`--${side}-on-dark`, onDark);
      root.style.setProperty(`--${side}-ring`, ratio(color, CHROME) < 3 ? 'rgba(255,255,255,.85)' : (ratio(color, LIGHT) < 3 ? DARK : 'transparent'));
      root.classList.toggle(`${side}-light`, light);
      root.classList.toggle(`${side}-accent-fixed`, logoFg !== acc);
    });
  }
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['style'] });
  apply();
})();

// ---------------------------------------------------------------- admin color pickers
(function () {
  'use strict';
  const C = window.Contrast;
  const boxes = document.querySelectorAll('.contrast-warn[data-contrast-for]');
  if (!boxes.length) return;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const NAMES = { '#ffff00': 'Yellow', '#ffffff': 'White', '#000000': 'Black', '#808080': 'Grey', '#ff0000': 'Red', '#0000ff': 'Blue', '#000080': 'Navy', '#ffa500': 'Orange', '#00ff00': 'Green' };
  const nm = (c) => NAMES[c.toLowerCase()] ? `${NAMES[c.toLowerCase()]} (${c})` : c;
  const chip = (fg, bg, txt = 'Aa', cls = '') => `<span class="cw-chip ${cls}" style="color:${esc(fg)};background:${esc(bg)}">${esc(txt)}</span>`;
  const btn = (input, val, label) => `<button type="button" class="sm" data-apply="${esc(input)}" data-val="${esc(val)}">${esc(label)}</button>`;

  function gameRows(f) {
    const rows = [];
    [['homeColor', 'useHomeColor', 'Home'], ['awayColor', 'useAwayColor', 'Away']].forEach(([k, use, lbl]) => {
      if (!f.elements[k] || (f.elements[use] && !f.elements[use].checked)) return;
      const P = f.elements[k].value; if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(P.trim())) return;
      const w = C.ratio('#ffffff', P);
      if (w < 4.5) rows.push(`${chip('#fff', P)} ${lbl}: white text on ${esc(nm(P))} is <b>${C.fmt(w)}</b>. Displays will use dark text ${chip(C.DARK, P)} (${C.fmt(C.ratio(C.DARK, P))}).`);
    });
    return rows;
  }
  const last = new WeakMap();
  function update() {
    boxes.forEach((box) => {
      const f = document.getElementById(box.dataset.contrastFor); if (!f) return;
      const rows = gameRows(f); // team colors are retired (season colors only)
      const html = rows.map((r) => `<div class="cw-row">⚠ ${r}</div>`).join('');
      if (last.get(box) === html) return;
      last.set(box, html); box.innerHTML = html; box.hidden = !rows.length;
    });
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-apply]'); if (!b) return;
    const f = b.closest('form'); const inp = f && f.elements[b.dataset.apply]; if (!inp) return;
    inp.value = b.dataset.val; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); update();
  });
  document.addEventListener('input', update); document.addEventListener('change', update); document.addEventListener('reset', () => setTimeout(update));
  // admin.js dispatches input events after filling the colors on Edit, so events are enough.
  update();
})();
