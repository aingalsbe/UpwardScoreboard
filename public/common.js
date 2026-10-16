// Shared realtime client (logic only; no styling). Used by TV, overlay and controller.
// - Always receives a full snapshot from the server on (re)connect = exact resync.
// - Estimates server clock offset from ping round-trips; the clock is computed
//   from server timestamps, never by counting ticks locally.
export function courtFromPath() { return decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || ''); }

// Liveness: browsers can't see protocol-level pings, so we send an app-level ping every
// second and treat ~3s of silence (no pong/state/time message) as a dead connection. That
// catches half-open sockets after a silent Wi-Fi drop. window offline/online events speed it up.
const PING_MS = 1000, DEAD_MS = 3000;

export function connect({ court, role, onState, onStatus, onMessage }) {
  let ws = null, backoff = 500, offset = 0, bestRtt = Infinity, closedByUs = false;
  let pingTimer = null, watchdog = null, retryTimer = null, lastMsgAt = 0, offlineAt = 0, state = 'connecting';
  const status = (s) => { if (s === state) return; state = s; onStatus && onStatus(s); };

  function detach(sock) { if (!sock) return; sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null; try { sock.close(); } catch {} }
  function scheduleReconnect(delay = backoff) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, delay);
    backoff = Math.min(backoff * 2, 8000);
  }
  function goOffline() {
    if (closedByUs) return;
    clearInterval(pingTimer); clearInterval(watchdog);
    detach(ws); ws = null;
    if (!offlineAt) offlineAt = Date.now(); // the clock freezes here (no jump back, no further countdown)
    status('offline');
    scheduleReconnect();
  }
  function open() {
    clearTimeout(retryTimer);
    detach(ws);
    if (!navigator.onLine) { status('offline'); return; } // the 'online' event will call us
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws?court=${encodeURIComponent(court)}&role=${role}`);
    ws = sock;
    if (state !== 'offline') queueMicrotask(() => status('connecting'));
    sock.onopen = () => {
      backoff = 500; bestRtt = Infinity; lastMsgAt = Date.now();
      ping();
      clearInterval(pingTimer); pingTimer = setInterval(ping, PING_MS);
      clearInterval(watchdog); watchdog = setInterval(() => { if (Date.now() - lastMsgAt > DEAD_MS) goOffline(); }, 500);
    };
    sock.onmessage = (ev) => {
      lastMsgAt = Date.now();
      const m = JSON.parse(ev.data);
      if (m.type === 'pong') {
        const rtt = Date.now() - m.t;
        if (rtt <= bestRtt) { bestRtt = rtt; offset = m.serverNow + rtt / 2 - Date.now(); }
        return;
      }
      if (m.type === 'state') {
        if (bestRtt === Infinity) offset = m.serverNow - Date.now();
        offlineAt = 0;
        onState(m);
        status('online'); // only "online" once we hold fresh server state
      }
      onMessage && onMessage(m);
    };
    sock.onclose = (ev) => { if (sock === ws) { if (ev.code === 4008) backoff = 8000; goOffline(); } };
    sock.onerror = () => { if (sock === ws) goOffline(); };
  }
  function ping() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); }
  window.addEventListener('offline', goOffline);
  window.addEventListener('online', () => { backoff = 500; open(); });
  open();
  // Coming back from sleep / tab hidden: force a fresh snapshot.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resync' })); });
  return {
    send: (obj) => { if (!ws || ws.readyState !== 1 || state !== 'online') return false; ws.send(JSON.stringify(obj)); return true; },
    serverNow: () => Date.now() + offset,
    /** Server time at which we lost the connection (or last heard from it): clocks freeze here. */
    lastServerNow: () => (offlineAt || lastMsgAt) + offset,
    isOpen: () => state === 'online',
    status: () => state,
    close: () => { closedByUs = true; clearInterval(pingTimer); clearInterval(watchdog); clearTimeout(retryTimer); detach(ws); },
  };
}

/** Clock time to show: live from server time when online; frozen at the last confirmed moment when not. */
export function displayNow(conn) { return conn.isOpen() ? conn.serverNow() : conn.lastServerNow(); }

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
    if (el.tagName === 'IMG') return; // image binds are set as src by the page
    const v = el.dataset.bind.split('.').reduce((o, k) => (o == null ? o : o[k]), data);
    const s = v == null ? '' : String(v);
    if (el.textContent !== s) el.textContent = s;
  });
}
