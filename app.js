/* ═══════════════════════════════════════════════════════════════
   FLIPTIME — app.js
   Full engine: flip clock, flip stopwatch, fullscreen, Wake Lock,
   OLED pixel-shift, settings, tick sound, brightness overlay.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ──────────────────────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────────────────────
const state = {
  mode:      'clock',      // 'clock' | 'stopwatch'
  h24:       false,
  showSec:   true,
  tickSound: false,
  fsActive:  false,

  // Stopwatch
  swRunning:   false,
  swStartedAt: 0,
  swElapsed:   0,          // ms accumulated before latest start

  wakeLock:   null,
  idleTimer:  null,
  pixelShift: { x: 0, y: 0 },
};

// ──────────────────────────────────────────────────────────────
// DOM refs (resolved once)
// ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const homeScreen        = $('home-screen');
const fullscreenView    = $('fullscreen-view');
const fsDisplay         = $('fs-display');
const fsLabels          = $('fs-labels');
const fsControls        = $('fs-controls');
const fsTapHint         = $('fs-tap-hint');
const fsSwBtn           = $('fs-sw-btn');
const previewClock      = $('preview-clock');
const swStartBtn        = $('sw-start-btn');
const swControlsHome    = $('stopwatch-controls-home');

// ──────────────────────────────────────────────────────────────
// AUDIO — minimal synthesised tick (no file needed, offline)
// ──────────────────────────────────────────────────────────────
let audioCtx = null;

function tick() {
  if (!state.tickSound) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 1000;
    gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.06);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.06);
  } catch (_) {}
}

// ──────────────────────────────────────────────────────────────
// FLIP CARD BUILDER
// Builds a full set of flip-card DOM nodes for one digit position
// ──────────────────────────────────────────────────────────────
function buildFlipCard(id) {
  /*
    Structure per digit:
    .flip-card
      .flip-upper (static top half — always shows CURRENT value)
        span
      .flip-lower (static bottom half — always shows CURRENT value)
        span
      .flip-front  (animated top half — shows OLD value, folds away)
        span
      .flip-back   (animated bottom half — shows NEW value, folds in)
        span
  */
  const wrap    = document.createElement('div');
  wrap.className = 'flip-card';
  wrap.id        = `fc-${id}`;

  const upper = document.createElement('div'); upper.className = 'flip-upper';
  const lower = document.createElement('div'); lower.className = 'flip-lower';
  const front = document.createElement('div'); front.className = 'flip-front';
  const back  = document.createElement('div'); back.className  = 'flip-back';

  [upper, lower, front, back].forEach(el => {
    const s = document.createElement('span');
    el.appendChild(s);
  });

  wrap.append(upper, lower, front, back);
  return wrap;
}

function buildSep() {
  const sep = document.createElement('div');
  sep.className = 'flip-sep';
  sep.innerHTML = '<span></span><span></span>';
  return sep;
}

function buildLabelEl(text) {
  const l = document.createElement('div');
  l.className = 'fs-seg-label';
  l.textContent = text;
  return l;
}

// ──────────────────────────────────────────────────────────────
// DIGIT UPDATER — triggers flip animation when digit changes
// ──────────────────────────────────────────────────────────────
const digitState = {};   // { [id]: currentChar }

function setDigit(id, newChar) {
  const card = document.getElementById(`fc-${id}`);
  if (!card) return;

  const prev = digitState[id];
  if (prev === newChar) return;   // no change, no animation needed
  digitState[id] = newChar;

  const upper = card.querySelector('.flip-upper span');
  const lower = card.querySelector('.flip-lower span');
  const front = card.querySelector('.flip-front');
  const back  = card.querySelector('.flip-back');
  const frontSpan = front.querySelector('span');
  const backSpan  = back.querySelector('span');

  // Put old value on the animated front panel
  if (prev !== undefined) frontSpan.textContent = prev;
  else frontSpan.textContent = newChar;

  // Put new value on the animated back panel
  backSpan.textContent = newChar;

  // Update static halves to new value immediately
  upper.textContent = newChar;
  lower.textContent = newChar;

  // Trigger animation by re-adding class
  front.classList.remove('flipping');
  back.classList.remove('flipping');
  // Force reflow
  void front.offsetWidth;
  front.classList.add('flipping');
  back.classList.add('flipping');

  tick();
}

// ──────────────────────────────────────────────────────────────
// CLOCK DISPLAY BUILDER
// Builds and renders digit groups into a target container
// ──────────────────────────────────────────────────────────────
function buildClockDOM(container, labelContainer, prefix) {
  // Clear existing digit state so new cards start fresh
  ['h0','h1','m0','m1','s0','s1'].forEach(k => delete digitState[`${prefix}-${k}`]);

  container.innerHTML   = '';
  if (labelContainer) labelContainer.innerHTML = '';

  function grp(ids, extraClass) {
    const g = document.createElement('div');
    g.className = 'flip-group' + (extraClass ? ` ${extraClass}` : '');
    ids.forEach(id => g.appendChild(buildFlipCard(`${prefix}-${id}`)));
    container.appendChild(g);
  }

  grp(['h0','h1']);
  container.appendChild(buildSep());

  grp(['m0','m1']);

  if (state.showSec) {
    container.appendChild(buildSep());
    grp(['s0','s1'], 'secs');   /* .secs → slightly smaller via CSS */
  }


  // AM/PM badge — shown only in clock 12h mode
  if (state.mode === 'clock' && !state.h24) {
    const badge = document.createElement('div');
    badge.id = `${prefix}-ampm`;
    badge.className = 'ampm-badge';
    container.appendChild(badge);
  }

  // ── Seed digits immediately with real values (no glitch on first render) ──
  const vals = state.mode === 'clock' ? getClockValues() : getSWValues();
  const { h, m, s, ampm } = vals;
  const hh = pad2(h), mm = pad2(m), ss = pad2(s);

  function seedCard(id, char) {
    const card = document.getElementById(`fc-${prefix}-${id}`);
    if (!card) return;
    digitState[`${prefix}-${id}`] = char;
    card.querySelectorAll('span').forEach(sp => sp.textContent = char);
  }

  seedCard('h0', hh[0]); seedCard('h1', hh[1]);
  seedCard('m0', mm[0]); seedCard('m1', mm[1]);
  if (state.showSec) { seedCard('s0', ss[0]); seedCard('s1', ss[1]); }

  // Seed AM/PM badge text
  const ampmBadge = document.getElementById(`${prefix}-ampm`);
  if (ampmBadge && ampm) ampmBadge.textContent = ampm;
}

// Preview (home screen) — smaller set, no labels
function buildPreview() {
  buildClockDOM(previewClock, null, 'pv');
}

// Fullscreen
function buildFsDOM() {
  buildClockDOM(fsDisplay, fsLabels, 'fs');
}

// ──────────────────────────────────────────────────────────────

// TIME / STOPWATCH VALUE FORMATTERS
// ──────────────────────────────────────────────────────────────
function getClockValues() {
  const now  = new Date();
  const raw  = now.getHours();          // 0–23
  const m    = now.getMinutes();
  const s    = now.getSeconds();
  const ampm = raw < 12 ? 'AM' : 'PM'; // always compute AM/PM

  let h;
  if (state.h24) {
    h = raw;                            // 0–23 in 24h mode
  } else {
    h = raw % 12 || 12;                 // 1–12 in 12h mode (never 0)
  }

  return { h, m, s, ampm };
}

function getSWValues() {
  let ms = state.swElapsed;
  if (state.swRunning) ms += Date.now() - state.swStartedAt;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600) % 100;
  const m = Math.floor(totalSec / 60) % 60;
  const s = totalSec % 60;
  return { h, m, s };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function applyValues(vals, prefix) {
  const { h, m, s, ampm } = vals;
  const hh = pad2(h), mm = pad2(m), ss = pad2(s);
  setDigit(`${prefix}-h0`, hh[0]);
  setDigit(`${prefix}-h1`, hh[1]);
  setDigit(`${prefix}-m0`, mm[0]);
  setDigit(`${prefix}-m1`, mm[1]);
  if (state.showSec) {
    setDigit(`${prefix}-s0`, ss[0]);
    setDigit(`${prefix}-s1`, ss[1]);
  }

  // Update AM/PM badge (only in clock mode, not stopwatch)
  if (state.mode === 'clock' && !state.h24 && ampm) {
    const badge = document.getElementById(`${prefix}-ampm`);
    if (badge) badge.textContent = ampm;
  }
}


// ──────────────────────────────────────────────────────────────
// MAIN TICK LOOP
// Runs every 250ms (lightweight), only triggers flip on change
// ──────────────────────────────────────────────────────────────
let tickLoop = null;

function startTickLoop() {
  if (tickLoop) return;
  tickLoop = setInterval(runTick, 250);
  runTick(); // immediate first paint
}

function runTick() {
  const vals = state.mode === 'clock' ? getClockValues() : getSWValues();
  applyValues(vals, 'pv');
  if (state.fsActive) applyValues(vals, 'fs');
}

// ──────────────────────────────────────────────────────────────
// PIXEL SHIFT — moves clock 1–2px every 5 min to prevent burn-in
// ──────────────────────────────────────────────────────────────
const SHIFT_RANGE = 6;   // px each direction
let lastShift = 0;

function maybePixelShift() {
  if (!state.fsActive) return;
  const now = Date.now();
  if (now - lastShift < 5 * 60 * 1000) return;
  lastShift = now;
  state.pixelShift.x = Math.floor(Math.random() * SHIFT_RANGE * 2 - SHIFT_RANGE);
  state.pixelShift.y = Math.floor(Math.random() * SHIFT_RANGE * 2 - SHIFT_RANGE);
  const wrap = $('fs-clock-wrap');
  if (wrap) wrap.style.transform = `translate(${state.pixelShift.x}px, ${state.pixelShift.y}px)`;
}

setInterval(maybePixelShift, 30_000);  // check every 30s

// ──────────────────────────────────────────────────────────────
// WAKE LOCK
// ──────────────────────────────────────────────────────────────
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => {
      // Re-request after visibility change
      if (state.fsActive && !document.hidden) requestWakeLock();
    });
  } catch (_) {}
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.fsActive) requestWakeLock();
});

// ──────────────────────────────────────────────────────────────
// FULLSCREEN — enter/exit
// ──────────────────────────────────────────────────────────────
function enterFullscreen(hint) {
  state.fsActive = true;

  homeScreen.classList.add('hidden');
  fullscreenView.classList.remove('hidden');

  buildFsDOM();
  runTick();
  updateFsSwBtn();
  requestWakeLock();
  setupIdleHide();

  // Request browser fullscreen
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
  if (req) {
    req.call(el, { navigationUI: 'hide' }).catch(() => {});
  }

  // For landscape hint, try screen orientation API
  if (hint === 'landscape' && screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').catch(() => {});
  }

  lastShift = 0; // reset pixel shift timer
}

function exitFullscreen() {
  state.fsActive = false;
  releaseWakeLock();
  clearTimeout(state.idleTimer);

  fullscreenView.classList.add('hidden');
  homeScreen.classList.remove('hidden');

  // Exit browser fullscreen
  const ex = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
  if (ex && document.fullscreenElement) ex.call(document).catch(() => {});

  // Unlock orientation
  if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
}

// ──────────────────────────────────────────────────────────────
// IDLE HIDE — controls fade after 3s of no interaction
// ──────────────────────────────────────────────────────────────
function setupIdleHide() {
  showFsControls();
  fullscreenView.addEventListener('click', onFsTap, { passive: true });
}

function onFsTap() {
  showFsControls();
}

function showFsControls() {
  fsControls.classList.remove('fs-controls-hidden');
  fsControls.classList.add('fs-controls-visible');
  fsTapHint.style.opacity = '0';

  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    fsControls.classList.remove('fs-controls-visible');
    fsControls.classList.add('fs-controls-hidden');
    fsTapHint.style.opacity = '1';
  }, 3000);
}

// ──────────────────────────────────────────────────────────────
// BRIGHTNESS OVERLAY
// ──────────────────────────────────────────────────────────────
let brightnessOverlay = null;

function ensureBrightnessOverlay() {
  if (!brightnessOverlay) {
    brightnessOverlay = document.createElement('div');
    brightnessOverlay.id = 'brightness-overlay';
    document.body.appendChild(brightnessOverlay);
  }
}

function setBrightness(val) {
  ensureBrightnessOverlay();
  // val 10–100 → overlay opacity 0–0.85
  const opacity = ((100 - val) / 100) * 0.88;
  brightnessOverlay.style.background = `rgba(0,0,0,${opacity.toFixed(3)})`;
}

// ──────────────────────────────────────────────────────────────
// MODE SELECTION (home screen)
// ──────────────────────────────────────────────────────────────
function selectMode(m) {
  state.mode = m;
  document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
  document.getElementById(`card-${m}`).classList.add('active');

  const isStopwatch = m === 'stopwatch';
  swControlsHome.classList.toggle('hidden', !isStopwatch);

  // Rebuild preview layout (seconds always shown in SW mode)
  buildPreview();
  runTick();
}

// ──────────────────────────────────────────────────────────────
// STOPWATCH PERSISTENCE  (localStorage — survives minimize/close)
// ──────────────────────────────────────────────────────────────
const SW_KEY = 'fliptime_sw';

function saveSW() {
  localStorage.setItem(SW_KEY, JSON.stringify({
    running:   state.swRunning,
    elapsed:   state.swElapsed,
    startedAt: state.swStartedAt,
  }));
}

function restoreSW() {
  try {
    const raw = localStorage.getItem(SW_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);

    state.swElapsed   = saved.elapsed   || 0;
    state.swStartedAt = saved.startedAt || 0;
    state.swRunning   = saved.running   || false;

    // If it was running when the app was closed/minimised,
    // the wall-clock time that passed while away is already
    // counted via (Date.now() - swStartedAt) in getSWValues().
    // We just need to reset swStartedAt to "now minus what's already in swElapsed"
    // so the elapsed counter is continuous.
    // Actually: leave swStartedAt as-is — getSWValues already does:
    //   if (swRunning) ms += Date.now() - swStartedAt
    // That naturally includes the time the phone was sleeping. ✅

    // Sync button UI
    if (state.swRunning) {
      swStartBtn.textContent = 'PAUSE';
      swStartBtn.classList.add('green');
      swStartBtn.classList.remove('red');
    } else if (state.swElapsed > 0) {
      swStartBtn.textContent = 'RESUME';
      swStartBtn.classList.add('red');
      swStartBtn.classList.remove('green');
    }
  } catch (_) {}
}

// ──────────────────────────────────────────────────────────────
// STOPWATCH CONTROLS
// ──────────────────────────────────────────────────────────────
function swToggle() {
  if (state.swRunning) {
    // Pause — lock in elapsed so far
    state.swElapsed += Date.now() - state.swStartedAt;
    state.swRunning   = false;
    swStartBtn.textContent = 'RESUME';
    swStartBtn.classList.remove('green');
    swStartBtn.classList.add('red');
  } else {
    // Start / Resume
    state.swStartedAt = Date.now();
    state.swRunning   = true;
    swStartBtn.textContent = 'PAUSE';
    swStartBtn.classList.remove('red');
    swStartBtn.classList.add('green');
  }
  saveSW();           // ← persist every change
  updateFsSwBtn();
}

function swReset() {
  state.swRunning   = false;
  state.swElapsed   = 0;
  state.swStartedAt = 0;
  swStartBtn.textContent = 'START';
  swStartBtn.classList.remove('red');
  swStartBtn.classList.add('green');
  saveSW();           // ← persist reset
  runTick();
  updateFsSwBtn();
}


// Fullscreen stopwatch buttons mirror home ones
function fsSWToggle() { swToggle(); }
function fsSWReset()  { swReset(); }

function updateFsSwBtn() {
  if (!fsSwBtn) return;
  if (state.mode !== 'stopwatch') {
    fsSwBtn.closest('#fs-mode-toggle').classList.add('hidden');
    return;
  }
  fsSwBtn.closest('#fs-mode-toggle').classList.remove('hidden');
  fsSwBtn.textContent = state.swRunning ? '⏸ Pause' : '▶ Start';
}

// ──────────────────────────────────────────────────────────────
// SETTINGS
// ──────────────────────────────────────────────────────────────
function toggleSetting(key) {
  if (key === 'h24')  state.h24       = $('toggle24h').checked;
  if (key === 'sec')  state.showSec   = $('toggleSec').checked;
  if (key === 'tick') state.tickSound = $('toggleTick').checked;

  // Rebuild clock layout when seconds toggled
  if (key === 'sec') {
    buildPreview();
    if (state.fsActive) buildFsDOM();
  }
  runTick();
}

// ──────────────────────────────────────────────────────────────
// HARDWARE BACK BUTTON / ESC KEY
// ──────────────────────────────────────────────────────────────
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.fsActive) exitFullscreen();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.fsActive) exitFullscreen();
});

// ──────────────────────────────────────────────────────────────
// SERVICE WORKER REGISTRATION
// ──────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ──────────────────────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────────────────────
function init() {
  restoreSW();        // ← load saved stopwatch before building UI
  buildPreview();
  startTickLoop();
  updateFsSwBtn();
}

document.addEventListener('DOMContentLoaded', init);
