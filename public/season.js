// Season colors on every screen (Aaron: season colors only, no screen-specific colors).
// The server injects the current values into each HTML page (<style id="season-vars">) so the first paint is right;
// this keeps them live: a read-only role=season WebSocket gets the colors on connect and after every season save.
// Sets on <html>: --season-light (home), --season-dark (away), --season-light-fg / --season-dark-fg (#000 or #fff,
// whichever reads best on that color). Fires window 'season' (detail = { name, dark, light }).
(function () {
  'use strict';
  const root = document.documentElement;
  const HEX = /^#[0-9a-f]{6}$/i;
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const fg = (h) => (lum(h) > 0.179 ? '#000000' : '#FFFFFF'); // whichever contrasts more: always >= 4.58:1
  const onDark = (h) => ((lum(h) + 0.05) / 0.05 >= 4.5 ? h : '#FFFFFF'); // season-colored text on black, else white
  let current = null;
  function apply(s) {
    if (!s || !HEX.test(s.light || '') || !HEX.test(s.dark || '')) return;
    const L = s.light.toUpperCase(), D = s.dark.toUpperCase();
    if (current && current.light === L && current.dark === D) return;
    current = { name: s.name, light: L, dark: D };
    root.style.setProperty('--season-light', L); root.style.setProperty('--season-dark', D);
    root.style.setProperty('--season-light-fg', fg(L)); root.style.setProperty('--season-dark-fg', fg(D));
    root.style.setProperty('--season-light-on-dark', onDark(L)); root.style.setProperty('--season-dark-on-dark', onDark(D));
    root.dataset.seasonLight = L; root.dataset.seasonDark = D;
    window.dispatchEvent(new CustomEvent('season', { detail: { ...current } }));
  }
  window.Season = { apply, get: () => current && { ...current } };
  let backoff = 1000, ws = null;
  function open() {
    if (ws && ws.readyState <= 1) return;
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?court=*&role=season`); } catch { return setTimeout(open, backoff); }
    ws.onopen = () => { backoff = 1000; };
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.kind === 'season') apply(m.season); } catch {} };
    ws.onclose = () => { setTimeout(open, backoff); backoff = Math.min(backoff * 2, 15000); };
  }
  open();
  // Back from sleep / hidden tab: ask again (the socket may have missed a save).
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resync' })); });
})();
