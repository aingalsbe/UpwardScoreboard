// Shared realtime client (logic only; no styling). Used by TV, overlay and controller.
// - Always receives a full snapshot from the server on (re)connect = exact resync.
// - Estimates server clock offset from ping round-trips; the clock is computed
//   from server timestamps, never by counting ticks locally.
export function courtFromPath() { return decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || ''); }

export function connect({ court, role, onState, onStatus, onMessage }) {
  let ws, backoff = 500, offset = 0, bestRtt = Infinity, closedByUs = false, pingTimer;
  const status = (s) => onStatus && onStatus(s);
  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?court=${encodeURIComponent(court)}&role=${role}`);
    queueMicrotask(() => status('connecting'));
    ws.onopen = () => { backoff = 500; bestRtt = Infinity; status('online'); ping(); clearInterval(pingTimer); pingTimer = setInterval(ping, 10000); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'pong') {
        const rtt = Date.now() - m.t;
        if (rtt <= bestRtt) { bestRtt = rtt; offset = m.serverNow + rtt / 2 - Date.now(); }
        return;
      }
      if (m.type === 'state') { if (bestRtt === Infinity) offset = m.serverNow - Date.now(); onState(m); }
      onMessage && onMessage(m);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (closedByUs) return;
      status('offline');
      setTimeout(open, backoff); backoff = Math.min(backoff * 2, 8000);
    };
    ws.onerror = () => ws.close();
  }
  function ping() { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); }
  open();
  // Coming back from sleep / tab hidden: force a fresh snapshot.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resync' })); });
  return {
    send: (obj) => { if (ws.readyState !== 1) return false; ws.send(JSON.stringify(obj)); return true; },
    serverNow: () => Date.now() + offset,
    isOpen: () => ws.readyState === 1,
    close: () => { closedByUs = true; ws.close(); },
  };
}

export function clockMs(clock, serverNow) {
  if (!clock) return 0;
  if (!clock.running || clock.startedAt == null) return Math.max(0, clock.remainingMs);
  return Math.max(0, clock.remainingMs - (serverNow - clock.startedAt));
}

export function fmtClock(ms) {
  if (ms < 60000) { // last minute: show tenths like a real scoreboard
    const s = Math.floor(ms / 1000), t = Math.floor((ms % 1000) / 100);
    return `${String(s).padStart(2, '0')}.${t}`;
  }
  const total = Math.ceil(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function periodLabel(p, periods) {
  if (p > periods) return `OT${p - periods > 1 ? p - periods : ''}`;
  return String(p);
}

/** Set every [data-bind="a.b"] element's text from an object. */
export function bindText(root, data) {
  root.querySelectorAll('[data-bind]').forEach((el) => {
    const v = el.dataset.bind.split('.').reduce((o, k) => (o == null ? o : o[k]), data);
    const s = v == null ? '' : String(v);
    if (el.textContent !== s) el.textContent = s;
  });
}
