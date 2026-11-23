// Release 1 (Aaron, 2026-11-23): the court TV buzzer. Logic + sound only; the look lives in tv.css (.sound-gate).
// - Plays for 3 seconds when the server says so: the game clock hit 0 at the end of a period, or a scorekeeper/Admin
//   pressed the manual buzzer (full court games). Always on: there is no mute.
// - The sound is synthesized with WebAudio (no audio file, no copyrighted asset).
// - Browsers block sound until someone taps the page, so each TV shows "Tap to enable sound" while audio is locked.
//   It stays away once enabled. A TV started with Chrome's --autoplay-policy=no-user-gesture-required never shows it.
//   localStorage remembers that this TV was enabled before, only so the gate can say "again" after a reload.

export const BUZZER_MS = 3000;
const ENABLED_KEY = 'sb-buzzer-enabled';

/** The buzzer sound as a schedule of [frequencyHz, type] voices; pure, so tests can check it. */
export const BUZZER_VOICES = [[196, 'sawtooth'], [247, 'square'], [392, 'sawtooth']];

export function createBuzzer({ gate, root = document.documentElement, AudioCtx = window.AudioContext || window.webkitAudioContext } = {}) {
  let ctx = null, playingUntil = 0;
  const seen = new Set(); // buzzer ids already played (a resent message never plays twice)
  const state = () => (ctx ? ctx.state : 'none');
  function ensure() {
    if (!ctx && AudioCtx) { try { ctx = new AudioCtx(); ctx.onstatechange = sync; } catch { ctx = null; } }
    return ctx;
  }
  function sync() {
    const locked = !ctx || ctx.state !== 'running';
    if (gate) {
      gate.hidden = !locked;
      const b = gate.querySelector('b'); if (b) b.textContent = localStorage.getItem(ENABLED_KEY) ? 'Tap to enable sound again' : 'Tap to enable sound';
    }
    root.dataset.sound = locked ? 'locked' : 'on';
    if (!locked) localStorage.setItem(ENABLED_KEY, '1');
  }
  function unlock() {
    const c = ensure(); if (!c) return;
    const p = c.resume && c.resume(); if (p && p.then) p.then(sync, sync); else sync();
  }
  // Any tap or key on the TV unlocks (the gate is just the obvious target).
  for (const ev of ['pointerdown', 'touchstart', 'keydown', 'click']) window.addEventListener(ev, unlock, { capture: true, passive: true });
  ensure(); unlock(); // autoplay-allowed TVs come up running without a tap
  setTimeout(sync, 400);

  /** 3 s of buzzer from now. */
  function play(ms = BUZZER_MS) {
    const c = ensure();
    root.classList.add('buzzing'); playingUntil = Date.now() + ms;
    setTimeout(() => { if (Date.now() >= playingUntil - 5) root.classList.remove('buzzing'); }, ms);
    window.__buzzerLog = [...(window.__buzzerLog || []), { at: Date.now(), ms, sound: state() }]; // QA hook (e2e/screenshots)
    if (!c || c.state !== 'running') { sync(); return false; }
    const t0 = c.currentTime, end = t0 + ms / 1000;
    const out = c.createGain(); out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(0.5, t0 + 0.03);
    out.gain.setValueAtTime(0.5, end - 0.08);
    out.gain.exponentialRampToValueAtTime(0.0001, end);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    lp.connect(out); out.connect(c.destination);
    for (const [f, type] of BUZZER_VOICES) {
      const o = c.createOscillator(); o.type = type; o.frequency.value = f;
      const g = c.createGain(); g.gain.value = 0.33; o.connect(g); g.connect(lp);
      o.start(t0); o.stop(end + 0.02);
    }
    return true;
  }
  /** A server 'buzzer' message: play once per id, and only if it's fresh (not a stale replay after a reconnect). */
  function onMessage(m, serverNow) {
    if (!m || m.type !== 'buzzer' || seen.has(m.id)) return false;
    seen.add(m.id);
    if (typeof serverNow === 'number' && typeof m.serverNow === 'number' && serverNow - m.serverNow > 2000) return false;
    return play(m.durationMs || BUZZER_MS), true;
  }
  if (gate) gate.addEventListener('click', unlock);
  return { play, onMessage, unlock, state };
}
