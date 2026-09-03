// app.js — boot, the figure renderer, and UI wiring.
//
// index.html owns structure, styles.css owns looks, tuner.js owns the audio graph and the
// parameters, tuner-worklet.js owns the DSP. This file turns the ~94 Hz stream of estimates into
// pixels and text, and does no arithmetic on phase.
//
// What the figure means, precisely — and this is worth being careful about, because the plan
// originally claimed something stronger. A 2:1 phasor ratio traces a FIXED closed curve (a
// limacon), traversed once per 1/df. Its SHAPE is set by the partial's relative amplitude and
// phase — a property of the string, bow and instrument. Its MOTION is the tuning error. So:
// shape reads as timbre, motion reads as error. The shape says nothing about pitch, and no copy
// in this UI may imply otherwise (ADDENDUM section 4).

const VER_PREFIX = "lt-v";   // must match sw.js's V stem — and V's numeric tail is load-bearing

const el = (id) => document.getElementById(id);
const fmtHz = (f) => (f >= 200 ? f.toFixed(1) : f.toFixed(2));
const fmtCents = (c) => (c > 0 ? "+" : c < 0 ? "−" : "") + Math.abs(c).toFixed(1);

// Last reading per string index, so the chips show the whole instrument at a glance after one
// pass across the strings — the quartet-useful view.
const lastByString = {};

// ---- the figure ------------------------------------------------------------
// The plan specifies decay trails as a canvas that is NEVER cleared, with a translucent background
// fillRect composited over it each frame. That does not work in 8-bit canvas: the fade is
// asymptotic, so each frame moves a channel by alpha*(target - current), which ROUNDS TO ZERO once
// the gap is under ~1/(2*alpha) — about 17/255 at alpha 0.03. Every stroke therefore leaves a
// permanent scar, and they accumulate for as long as the app is open. Measured on the real page:
// a corner the trace had touched once sat at rgb(244,243,224) against a rgb(244,243,239) ground and
// stayed there.
//
// So keep the points and restroke them. The plan rejected this as expensive, but the trail is only
// ~0.5 s of a ~94 Hz stream: about 75 segments, redrawn at 60 fps. That is nothing, and it buys an
// exact decay, correct behaviour across resize and theme changes, and the per-segment colour ramp
// that was on the wish list anyway.
//
// Points are captured in the ESTIMATE handler, not in the rAF loop: sampling the latest estimate
// once per frame would drop a third of a 94 Hz stream and duplicate others, which shows up as an
// unevenly-spaced figure. Every estimate lands on the curve exactly once.
const TRAIL_CAP = 6000;      // ring capacity: ~4 s at 16 points x ~94 messages/s
const TRAIL_CHUNKS = 28;     // constant-alpha polylines per frame (see drawFrame)
const TRAIL_FLOOR = 0.02;    // drop a point once it is this faint — invisible, and unbounded otherwise

const fig = {
  canvas: null, ctx: null, w: 0, h: 0, dpr: 1,
  // A ring buffer of plain typed arrays rather than an array of {x,y,c,t} objects: at ~1500 points
  // a second, allocating an object per point is real garbage on the render path.
  bx: new Float32Array(TRAIL_CAP), by: new Float32Array(TRAIL_CAP),
  bc: new Float32Array(TRAIL_CAP), bt: new Float64Array(TRAIL_CAP),
  head: 0, count: 0,
  running: false, frozen: false,
};

// Oldest-first position i -> ring index.
const ringIdx = (i) => (fig.head - fig.count + i + TRAIL_CAP * 2) % TRAIL_CAP;

function trailPush(x, y, c, t) {
  fig.bx[fig.head] = x; fig.by[fig.head] = y;
  fig.bc[fig.head] = c === null || c === undefined ? NaN : c;
  fig.bt[fig.head] = t;
  fig.head = (fig.head + 1) % TRAIL_CAP;
  if (fig.count < TRAIL_CAP) fig.count++;
}
function trailClear() { fig.head = 0; fig.count = 0; }

// The knob is a per-frame alpha, so convert it to a per-second decay constant at a nominal 60 fps.
// Keeping the knob in the plan's units means a value calibrated on one device still means the same
// thing on another, where the frame rate may not be 60.
function decayPerSec() {
  const a = Math.min(0.5, Math.max(0.001, Tuner.params.trailAlpha));
  return -60 * Math.log(1 - a);
}

function resizeFigure() {
  const c = fig.canvas;
  if (!c) return;
  const r = c.getBoundingClientRect();
  const dpr = Math.min(3, window.devicePixelRatio || 1);   // cap: a 4x buffer costs fill rate
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (w === fig.w && h === fig.h && dpr === fig.dpr) return;
  fig.w = c.width = w; fig.h = c.height = h; fig.dpr = dpr;
}

function bgColor() { return Theme.getCssColor("--bg") || "#0e1413"; }

function clearFigure() {
  if (!fig.ctx) return;
  fig.ctx.setTransform(1, 0, 0, 1, 0, 0);
  fig.ctx.fillStyle = bgColor();
  fig.ctx.fillRect(0, 0, fig.w, fig.h);
}

// Colour the trace by error sign when asked. Deliberately a TASTE knob: it cannot change the
// number, only how fast you read its sign — which the direction of rotation already tells you.
function traceColor(cents) {
  if (!Tuner.params.hueByError || cents === null || Number.isNaN(cents) || Math.abs(cents) < 1.0) {
    return Theme.getCssColor("--trace") || "#2ee6a8";
  }
  return Theme.getCssColor(cents > 0 ? "--sharp" : "--flat") || "#2ee6a8";
}

// Called once per estimate (~94 Hz). Each message carries the whole sub-quantum path since the
// last one (16 points), not a single sample — that is what stops the figure drawing as a polygon
// at large errors, where the beat is fast enough that 94 Hz gives under 20 points per revolution.
function pushPoint(m) {
  // Gated or searching: stop capturing. The existing points stay, so the figure freezes exactly as
  // it was rather than decaying away — a decaying figure would erase the evidence of what the last
  // real reading looked like, and a frozen one that still looks in tune is why the dimming exists.
  if (m.st === 0 || m.st === 2) { fig.frozen = true; return; }
  fig.frozen = false;
  const t = performance.now();
  const path = m.p;
  if (path && path.length >= 2) {
    // Spread the points across the message interval so the decay ramps smoothly rather than in
    // 16-point steps. dt is tiny (~0.7 ms) but the arithmetic is free.
    const n = path.length / 2;
    const dt = 1000 / (Tuner.engine.ctx ? Tuner.engine.ctx.sampleRate / 128 / 4 : 94) / n;
    for (let i = 0; i < n; i++) {
      trailPush(path[i * 2], path[i * 2 + 1], m.c, t - (n - 1 - i) * dt);
    }
  } else {
    trailPush(m.x, m.y, m.c, t);
  }
}

function drawFrame() {
  if (!fig.ctx) return;
  if (fig.frozen) return;              // hold the last painted frame, untouched
  const ctx = fig.ctx;
  clearFigure();
  if (fig.count < 2) return;

  const cx = fig.w / 2, cy = fig.h / 2;
  const R = Math.min(fig.w, fig.h) * 0.36;
  const rot = (Tuner.params.orientation * Math.PI) / 180;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const k = decayPerSec();
  const now = performance.now();
  const maxAge = (-Math.log(TRAIL_FLOOR) / k) * 1000;

  let first = 0;
  while (first < fig.count && now - fig.bt[ringIdx(first)] > maxAge) first++;
  const live = fig.count - first;
  if (live < 2) return;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Tuner.params.strokeWidth * fig.dpr;

  // y is negated: the worklet works in maths orientation, the canvas in screen orientation.
  const sx = (j) => cx + R * (fig.bx[j] * cos - fig.by[j] * sin);
  const sy = (j) => cy - R * (fig.bx[j] * sin + fig.by[j] * cos);

  // Stroke the trail as TRAIL_CHUNKS constant-alpha polylines rather than one path per segment.
  // With ~3200 live points a per-segment stroke would be 3200 draw calls a frame; this is 28, and
  // a 28-step alpha ramp is indistinguishable from a continuous one at these opacities.
  const chunks = Math.min(TRAIL_CHUNKS, live - 1);
  const per = Math.ceil(live / chunks);
  for (let c = 0; c < chunks; c++) {
    const a0 = first + c * per;
    const a1 = Math.min(fig.count, a0 + per + 1);    // +1 so consecutive chunks share a point
    if (a1 - a0 < 2) continue;
    const mid = ringIdx((a0 + a1) >> 1);
    const alpha = Math.exp((-k * (now - fig.bt[mid])) / 1000);
    if (alpha < TRAIL_FLOOR) continue;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = traceColor(fig.bc[mid]);
    ctx.beginPath();
    let j = ringIdx(a0);
    ctx.moveTo(sx(j), sy(j));
    for (let i = a0 + 1; i < a1; i++) { j = ringIdx(i); ctx.lineTo(sx(j), sy(j)); }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function loop() {
  if (!fig.running) return;
  resizeFigure();
  drawFrame();
  requestAnimationFrame(loop);
}

// ---- readouts ---------------------------------------------------------------
function paintEstimate(m) {
  const ref = Tuner.referencePlaying();
  // While a reference tone sounds, the microphone is hearing OUR tone. The tuner would lock that
  // string and report ~0.0 cents, which is indistinguishable from a perfectly tuned instrument —
  // the most dangerous thing this app could show. Freeze and say what is actually happening.
  if (ref >= 0) {
    fig.frozen = true;
    const stage = document.querySelector(".stage");
    stage.classList.add("gated");
    stage.classList.remove("searching");
    el("string-name").textContent = Tuner.stringNames()[ref];
    el("target-hz").textContent = fmtHz(Tuner.targets()[ref]) + " Hz";
    el("measured-hz").textContent = "";
    el("cents").textContent = "♪";
    el("cents").classList.remove("sharp", "flat");
    el("direction").textContent = "reference tone";
    return;
  }

  pushPoint(m);
  const stage = document.querySelector(".stage");
  stage.classList.toggle("gated", m.st === 0);
  stage.classList.toggle("searching", m.st === 2);

  const names = Tuner.stringNames();
  const targets = Tuner.targets();
  const nameEl = el("string-name");

  if (m.s >= 0 && m.s < names.length) {
    nameEl.textContent = names[m.s];
    el("target-hz").textContent = fmtHz(targets[m.s]) + " Hz";
  } else {
    nameEl.textContent = "—";
    el("target-hz").textContent = "";
  }

  const centsEl = el("cents");
  const dirEl = el("direction");
  centsEl.classList.remove("sharp", "flat");

  if (m.st === 2) {
    centsEl.textContent = "—"; dirEl.textContent = "listening";
    el("measured-hz").textContent = "";
  } else if (m.st === 3) {
    // Past the reporting range we may be locked to the wrong string, so a number would be a lie.
    centsEl.textContent = "—"; dirEl.textContent = "out of range";
    el("measured-hz").textContent = "";
  } else if (m.c === null) {
    centsEl.textContent = "—"; dirEl.textContent = " ";
  } else {
    centsEl.textContent = fmtCents(m.c);
    // Rotation direction already gives the sign; the word is here anyway because reading a
    // direction takes a beat longer than reading a word.
    dirEl.textContent = Math.abs(m.c) < 0.5 ? "in tune" : m.c > 0 ? "sharp" : "flat";
    if (Math.abs(m.c) >= 0.5) centsEl.classList.add(m.c > 0 ? "sharp" : "flat");
    if (m.s >= 0) {
      el("measured-hz").textContent = fmtHz(targets[m.s] * Math.pow(2, m.c / 1200)) + " Hz";
      lastByString[m.s] = m.c;
    }
  }
  // A lone "MEASURED" under nothing reads as a bug; hide the caption with its value.
  for (const id of ["target-hz", "measured-hz"]) {
    const v = el(id);
    const cap = v.parentNode.querySelector("small");
    if (cap) cap.style.visibility = v.textContent ? "visible" : "hidden";
  }
  paintChips(m.s);
}

function paintChips(activeIdx) {
  const wrap = el("chips");
  const names = Tuner.stringNames();
  if (wrap.children.length !== names.length) {
    wrap.innerHTML = "";
    names.forEach((_, i) => {
      // A button, not a div: tapping a string plays its target pitch, so it needs to be a real
      // control — focusable, and a proper tap target on a phone.
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.innerHTML = "<b></b><span></span>";
      b.onclick = () => toggleReference(i);
      wrap.appendChild(b);
    });
  }
  const playing = Tuner.referencePlaying();
  names.forEach((n, i) => {
    const chip = wrap.children[i];
    const c = lastByString[i];
    chip.classList.toggle("active", i === activeIdx);
    chip.classList.toggle("playing", i === playing);
    chip.classList.remove("sharp", "flat");
    chip.children[0].textContent = n;
    chip.title = "Play " + n + " (" + fmtHz(Tuner.targets()[i]) + " Hz)";
    if (i === playing) { chip.children[1].textContent = "♪ playing"; return; }
    if (c === undefined) { chip.children[1].textContent = "–"; return; }
    chip.children[1].textContent = fmtCents(c);
    if (Math.abs(c) >= 0.5) chip.classList.add(c > 0 ? "sharp" : "flat");
  });
}

function toggleReference(i) {
  if (Tuner.referencePlaying() === i) { Tuner.stopReference(); onReferenceChange(-1); }
  else Tuner.playReference(i);   // async (it may have to create/resume the context) — the engine
                                 // calls onReference when the tone is actually sounding.
}

// Fires when a reference tone starts, is stopped, or times out on its own. Repaints directly
// because the estimate stream may not be running at all — the reference tone works before Start.
function onReferenceChange() {
  const last = Tuner.engine.lastEstimate;
  paintChips(last ? last.s : -1);
  paintEstimate(last || { s: -1, c: null, st: 2, x: 0, y: 0, th: 0, r: 0 });
}

// ---- controls ----------------------------------------------------------------
// The shipped UI is three controls. Everything else is behind ?dev=1 and, once calibrated, gets
// baked into source and the knob deleted.
function buildSegmented(node, options, get, set) {
  node.innerHTML = "";
  options.forEach(([value, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.textContent = label;
    b.onclick = () => { set(value); syncControls(); };
    b.dataset.value = value;
    node.appendChild(b);
  });
  node._get = get;
}

function syncControls() {
  for (const id of ["instrument", "temperament"]) {
    const node = el(id);
    const current = String(node._get());
    for (const b of node.children) b.setAttribute("aria-checked", String(b.dataset.value === current));
  }
  el("refa-value").textContent = Tuner.settings.refA.toFixed(1);
  // A changed instrument means a different number of strings and different targets; drop the
  // per-string memory rather than showing a G3 reading under a C2 label.
  paintChips(Tuner.engine.lastEstimate ? Tuner.engine.lastEstimate.s : -1);
}

function wireControls() {
  buildSegmented(el("instrument"),
    Object.keys(Strings.INSTRUMENTS).map((k) => [k, Strings.INSTRUMENTS[k].label]),
    () => Tuner.settings.instrument,
    (v) => { for (const k in lastByString) delete lastByString[k]; Tuner.setSetting("instrument", v); });

  buildSegmented(el("temperament"), [["pure", "Pure"], ["equal", "Equal"]],
    () => Tuner.settings.temperament,
    (v) => Tuner.setSetting("temperament", v));

  // Reference A: 392–466 in 0.5 Hz steps.
  const stepA = (d) => {
    const next = Math.min(466, Math.max(392, Math.round((Tuner.settings.refA + d) * 2) / 2));
    Tuner.setSetting("refA", next);
    syncControls();
  };
  el("refa-down").onclick = () => stepA(-0.5);
  el("refa-up").onclick = () => stepA(0.5);

  el("theme").onclick = () => Theme.cycle();
  el("start").onclick = onStart;
}

function updateThemeLabel() {
  const b = el("theme");
  if (b) b.textContent = Theme.get().replace(/^./, (c) => c.toUpperCase());
}

function onThemeChange() {
  updateThemeLabel();
  clearFigure();   // every frame repaints from the point buffer, so the new ground is enough
}

// ---- start / failure states ---------------------------------------------------
function showOverlay(msg, button, note, isError) {
  const o = el("overlay");
  o.hidden = false;
  o.classList.toggle("error", !!isError);
  el("overlay-msg").textContent = msg;
  el("start").textContent = button;
  el("start").hidden = !button;
  el("overlay-note").textContent = note || "";
}

async function onStart() {
  showOverlay("Starting…", "", "");
  try {
    await Tuner.start();
    el("overlay").hidden = true;
    document.querySelector(".stage").classList.add("live");
    fig.running = true;
    trailClear();
    clearFigure();
    requestAnimationFrame(loop);
  } catch (err) {
    const name = (err && err.name) || String(err);
    // Real UI for the failures that actually happen, not a console message.
    if (name === "NotAllowedError" || name === "SecurityError") {
      showOverlay(
        "Microphone access was denied. The tuner cannot hear anything without it.",
        "Try again",
        "Safari: aA menu → Website Settings → Microphone → Allow. Installed to the home screen, check iOS Settings → Lissajous Tuner.",
        true);
    } else if (name === "NotFoundError") {
      showOverlay("No microphone found on this device.", "Try again", "", true);
    } else {
      showOverlay("Could not start audio: " + name, "Try again", "", true);
    }
  }
}

// ---- build id ------------------------------------------------------------------
// Always visible, never dev-gated. checkVer() may later append a "→ newer" hint and make it
// tappable; until then this is just the identity of what is on screen.
function paintBuildId(extra, onTap) {
  const b = el("buildid");
  if (!b) return;
  const info = window.BUILD || { sha: "dev", v: "?" };
  b.textContent = info.sha + " · " + info.v + (extra || "");
  // Always tappable: wireDevGesture() listens here too, so this must not turn pointer events off.
  b.style.pointerEvents = "auto";
  b.style.cursor = onTap ? "pointer" : "default";
  b.onclick = onTap || null;
}

// ---- service-worker version tag (unchanged plumbing) -----------------------
async function checkVer(){
  // HIGHEST version, not the first key: two caches can legitimately coexist for a while (sw.js
  // keeps the old one as a net until the new precache is complete), and caches.keys() is in
  // creation order — so find() would report the OLD version as installed and show a permanent
  // "tap to update" tag on an already-current device.
  //
  // But only among caches that actually HOLD something. sw.js's ensureShellOnce() calls
  // caches.open(V) before it fetches anything, so a bumped version exists as an EMPTY cache the
  // moment an install starts — and per-file precaching means that worker activates even if every
  // shell fetch failed. Ranking on names alone then reads the empty placeholder as "installed",
  // concludes the device is current, and hides the tag on a device still serving the PREVIOUS
  // release out of the old cache — killing the one affordance that unsticks it by hand. A
  // partly-filled new cache still reads as installed; that state repairs itself on the next
  // top-up, whereas the empty one can persist.
  let installed = "";
  try{
    const keys = (await caches.keys()).filter(k => k.startsWith(VER_PREFIX));
    const sized = await Promise.all(
      keys.map(async k => [(await (await caches.open(k)).keys()).length, k]));
    installed = sized
      .filter(([n]) => n > 0)
      .map(([, k]) => [parseInt(k.slice(VER_PREFIX.length), 10) || 0, k])
      .sort((a, b) => a[0] - b[0])
      .map(([, k]) => k)
      .pop() || "";
  }catch{}
  if(!installed){ paintBuildId(); return; }

  let latest = "";
  try{   // ?_= + no-store dodges both the SW cache and the HTTP cache → the live sw.js on the server
    const src = await (await fetch("./sw.js?_=" + Date.now(), {cache:"no-store"})).text();
    // Read the DECLARATION, not the first prefix-shaped string anywhere in the file: sw.js's
    // comments cite version names as examples, so an unanchored /app-v\d+/ scan can match a
    // comment and pin a permanent "tap to update" tag that does nothing when tapped
    // (forceUpdate() clears caches, reloads, and re-reads the same comment). Same expression as
    // scripts/sw-lint.py's ver(); keep the two in agreement.
    latest = (src.match(/const V\s*=\s*"([^"]*)"/) || ["", ""])[1];
  }catch{}   // offline: leave latest empty → neutral tag, never a false "behind"

  // The build id is always on screen, so the "you're behind" affordance rides on it rather than
  // occupying a second slot. `installed` is the SW cache generation; build.js's own .v is what
  // was stamped at deploy — they agree unless the cache is mid-swap.
  const behind = latest && latest !== installed;
  paintBuildId(behind ? "  →  " + latest + " · tap to update" : "", behind ? forceUpdate : null);
}

async function forceUpdate(){   // the hammer: drop every cache, reload → SW reinstalls the latest shell
  try{ await Promise.all((await caches.keys()).map(k => caches.delete(k))); }catch{}
  location.reload();
}

// Ask the active SW to top up any missing precache entries. iOS can reclaim Cache API contents
// (storage pressure, ~7 idle days) while leaving the registration in place, and sw.js only
// precaches on install — i.e. on a V bump. Without this nudge a device whose cache got evicted
// stays broken offline indefinitely; with it, one online launch repairs it.
function requestShellTopUp(){
  if(!("serviceWorker" in navigator) || !navigator.onLine) return;
  // getRegistration() resolves undefined when there's nothing registered; .ready would just
  // never settle, leaving a pending promise behind on every foreground.
  navigator.serviceWorker.getRegistration()
    .then(reg => { if(reg && reg.active) reg.active.postMessage("ensure-shell"); })
    .catch(() => {});
}

// ---- dev panel (?dev=1) ----------------------------------------------------------
// Generated from Tuner.PARAMS so adding a knob is one line. The two classes are rendered as two
// SEPARATE groups on purpose: a taste knob cannot produce a wrong reading, a measurement knob can,
// and putting them in one list invites the second to be treated like the first.
let devStatsTimer = null;

function buildDevPanel() {
  const panel = el("dev");
  panel.hidden = false;
  // Build it, but open it CLOSED. The panel is fixed to the bottom of the viewport, so leaving it
  // open on load covers the Start button — with ?dev=1 the app could not be started at all, on a
  // phone or anywhere else. The toggle is the only thing on screen until you ask for the rest.
  panel.style.display = "none";

  const toggle = document.createElement("button");
  toggle.className = "dev-toggle";
  toggle.textContent = "dev";
  toggle.setAttribute("aria-expanded", "false");
  toggle.onclick = () => {
    const open = panel.style.display === "none";
    panel.style.display = open ? "" : "none";
    toggle.setAttribute("aria-expanded", String(open));
  };
  document.body.appendChild(toggle);

  // Live measurements. This is what turns the one unverifiable constant in the plan into a minimum
  // on a curve you can see: sweep the bandwidth against a sustained real note and take the lowest
  // value whose jitter stops improving but which doesn't drop lock under vibrato.
  const stats = document.createElement("div");
  stats.className = "dev-stats";
  stats.innerHTML = `
    <div><b id="st-jitter">–</b><small>cents SD (2 s)</small></div>
    <div><b id="st-drops">0</b><small>lock drops</small></div>
    <div><b id="st-gates">0</b><small>gate closes</small></div>
    <div><b id="st-rate">–</b><small>sample rate</small></div>
    <div><b id="st-state">–</b><small>state</small></div>`;
  panel.appendChild(stats);

  for (const cls of ["measure", "taste"]) {
    const h = document.createElement("h3");
    h.innerHTML = cls === "measure"
      ? 'Measurement <em>— changes what the app reports. Calibrate, then bake into source.</em>'
      : 'Taste <em>— cannot produce a wrong reading.</em>';
    panel.appendChild(h);

    for (const key in Tuner.PARAMS) {
      const spec = Tuner.PARAMS[key];
      if (spec.cls !== cls) continue;
      const row = document.createElement("div");
      row.className = "dev-row";
      const value = Tuner.params[key];
      row.innerHTML = `<label for="p-${key}">${spec.label}</label>
        <output id="o-${key}">${value}${spec.unit ? " " + spec.unit : ""}</output>
        <input type="range" id="p-${key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${value}">
        ${spec.help ? `<div class="help">${spec.help}</div>` : ""}`;
      panel.appendChild(row);
      row.querySelector("input").oninput = (e) => {
        const v = parseFloat(e.target.value);
        Tuner.setParam(key, v);
        el("o-" + key).textContent = v + (spec.unit ? " " + spec.unit : "");
        syncHash();
      };
    }
  }

  const actions = document.createElement("div");
  actions.className = "dev-actions";
  actions.innerHTML = `
    <button type="button" id="dev-copy">Copy diagnostics</button>
    <button type="button" id="dev-js">Copy as JS</button>
    <button type="button" id="dev-rec">Record 15 s</button>
    <button type="button" id="dev-reset">Reset params</button>`;
  panel.appendChild(actions);

  el("dev-copy").onclick = () => copyText(diagnostics(), el("dev-copy"), "Copy diagnostics");
  el("dev-js").onclick = () => copyText(paramsAsJs(), el("dev-js"), "Copy as JS");
  el("dev-reset").onclick = () => { Tuner.resetParams(); location.hash = ""; location.reload(); };
  el("dev-rec").onclick = onRecord;

  devStatsTimer = setInterval(paintDevStats, 250);
  applyHash();
}

function paintDevStats() {
  const j = Tuner.jitter();
  const s = Tuner.engine.stats;
  const m = Tuner.engine.lastEstimate;
  const STATES = ["gated", "locked", "searching", "out of range"];
  el("st-jitter").textContent = j === null ? "–" : j.toFixed(3);
  el("st-drops").textContent = s.lockDrops;
  el("st-gates").textContent = s.gateCloses;
  el("st-rate").textContent = Tuner.engine.ctx ? Tuner.engine.ctx.sampleRate : "–";
  el("st-state").textContent = m ? STATES[m.st] : "–";
}

// Sync live values into the URL hash, so a configuration you like is a link you can text yourself.
function syncHash() {
  const diff = changedParams();
  location.replace("#" + new URLSearchParams(diff).toString());
}
function applyHash() {
  if (!location.hash || location.hash.length < 2) return;
  const q = new URLSearchParams(location.hash.slice(1));
  for (const [k, v] of q) {
    if (!(k in Tuner.PARAMS)) continue;
    const n = parseFloat(v);
    if (!Number.isFinite(n)) continue;
    Tuner.setParam(k, n);
    const input = el("p-" + k), out = el("o-" + k);
    if (input) input.value = n;
    if (out) out.textContent = n + (Tuner.PARAMS[k].unit ? " " + Tuner.PARAMS[k].unit : "");
  }
}

function changedParams() {
  const diff = {};
  for (const k in Tuner.PARAMS) {
    if (Tuner.params[k] !== Tuner.PARAMS[k].def) diff[k] = Tuner.params[k];
  }
  return diff;
}

// Only the parameters that DIFFER from default, ready to paste back into source. The constants
// ship; the panel does not need to.
function paramsAsJs() {
  const diff = changedParams();
  if (!Object.keys(diff).length) return "// all parameters at default\n";
  const body = Object.keys(diff).map((k) => `  ${k}: ${diff[k]},`).join("\n");
  return `// paste into tuner.js PARAMS defaults\nconst VIZ = {\n${body}\n};\n`;
}

// One pasteable block. Everything needed to reproduce a report without a conversation about it.
function diagnostics() {
  const e = Tuner.engine;
  const m = e.lastEstimate;
  const b = window.BUILD || {};
  const t = Tuner.targets();
  const names = Tuner.stringNames();
  const standalone = window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
  const STATES = ["gated", "locked", "searching", "out of range"];
  const j = Tuner.jitter();
  const lines = [
    "Lissajous Tuner — diagnostics",
    "build        " + (b.sha || "?") + " · " + (b.v || "?") + "  built " + (b.at || "?"),
    "url          " + location.href,
    "display      " + (standalone ? "standalone (installed)" : "browser tab"),
    "UA           " + navigator.userAgent,
    "sampleRate   " + (e.ctx ? e.ctx.sampleRate : "(not started)"),
    "instrument   " + e.settings.instrument + "   refA " + e.settings.refA.toFixed(1) + "   " + e.settings.temperament,
    "string       " + (m && m.s >= 0 ? names[m.s] + " (index " + m.s + ")" : "(none locked)"),
    "target       " + (m && m.s >= 0 ? t[m.s].toFixed(3) + " Hz" : "–"),
    "cents        " + (m && m.c !== null && m.c !== undefined ? fmtCents(m.c) : "(not reported)"),
    "measured     " + (m && m.c !== null && m.s >= 0 ? (t[m.s] * Math.pow(2, m.c / 1200)).toFixed(3) + " Hz" : "–"),
    "state        " + (m ? m.st + " (" + STATES[m.st] + ")" : "–"),
    "jitter       " + (j === null ? "–" : j.toFixed(4) + " cents SD over 2 s"),
    "lock drops   " + e.stats.lockDrops,
    "gate closes  " + e.stats.gateCloses,
    "messages     " + e.stats.messages,
    "test mode    " + (Tuner.FLAGS.test ? "on, " + Tuner.FLAGS.cents + " cents" : "off"),
    "params       " + JSON.stringify(Tuner.params),
    "non-default  " + JSON.stringify(changedParams()),
  ];
  return lines.join("\n") + "\n";
}

function copyText(text, button, label) {
  const done = (ok) => {
    button.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(() => { button.textContent = label; }, 1400);
  };
  // navigator.clipboard needs a secure context AND is absent in some iOS standalone cases, so
  // keep the execCommand fallback — a diagnostics button that silently does nothing is worse
  // than no button.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => done(true), () => fallback());
  } else fallback();

  function fallback() {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      done(ok);
    } catch (e) { done(false); }
  }
}

// Record raw PCM, then hand back a .f32 plus a sidecar JSON. A recording of a real bowed cello C2
// is worth more than any synthetic fixture in this repo — these two files drop straight into
// tests/ as an additional case.
function onRecord() {
  const btn = el("dev-rec");
  if (!Tuner.engine.running) { btn.textContent = "start first"; setTimeout(() => btn.textContent = "Record 15 s", 1400); return; }
  btn.textContent = "Recording…";
  Tuner.engine.onRecording = (data) => {
    btn.textContent = "Record 15 s";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const m = Tuner.engine.lastEstimate;
    download(new Blob([data.rec.buffer], { type: "application/octet-stream" }), `tuner-${stamp}.f32`);
    download(new Blob([JSON.stringify({
      sampleRate: data.sampleRate,
      instrument: Tuner.settings.instrument,
      string: m && m.s >= 0 ? Tuner.stringNames()[m.s] : null,
      stringIndex: m ? m.s : -1,
      refA: Tuner.settings.refA,
      temperament: Tuner.settings.temperament,
      samples: data.rec.length,
      params: Tuner.params,
    }, null, 2)], { type: "application/json" }), `tuner-${stamp}.json`);
    // Replay it immediately: the same audio under whatever parameters you move next.
    Tuner.replay(data.rec, data.sampleRate);
  };
  Tuner.record(15);
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// An installed PWA has NO URL BAR, so ?dev=1 cannot be typed once the app is on the home screen —
// which is exactly where it needs calibrating against a real instrument. Three taps on the build id
// opens the panel. Deliberately obscure (it must not be reachable by accident) but not hidden: the
// build id is the one element always on screen, and it is already the thing you look at to report
// a bug.
function wireDevGesture() {
  const b = el("buildid");
  if (!b) return;
  let taps = 0, timer = null;
  b.style.pointerEvents = "auto";
  b.addEventListener("click", () => {
    taps++;
    clearTimeout(timer);
    timer = setTimeout(() => { taps = 0; }, 600);
    if (taps < 3) return;
    taps = 0;
    if (!el("dev").hasChildNodes()) buildDevPanel();
    const panel = el("dev");
    panel.hidden = false;
    panel.style.display = panel.style.display === "none" ? "" : "none";
    const t = document.querySelector(".dev-toggle");
    if (t) t.setAttribute("aria-expanded", String(panel.style.display !== "none"));
  });
}

// ---- boot ------------------------------------------------------------------------
function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", requestShellTopUp);
  }

  Theme.init();
  Theme.subscribe(onThemeChange);
  updateThemeLabel();

  fig.canvas = el("figure");
  fig.ctx = fig.canvas.getContext("2d");
  resizeFigure();
  addEventListener("resize", resizeFigure);

  wireControls();
  syncControls();
  paintChips(-1);
  paintBuildId();

  Tuner.engine.onEstimate = paintEstimate;
  Tuner.engine.onReference = onReferenceChange;

  if (Tuner.FLAGS.test) {
    // Self-test: no microphone involved, so say what is being asserted rather than asking for
    // permission the app will not use.
    showOverlay(
      `Self-test: a synthetic tone ${Tuner.FLAGS.cents} cents off. At 3.93 cents the figure turns exactly once per second.`,
      "Run self-test", "No microphone is used in this mode.");
  }
  if (Tuner.FLAGS.dev) buildDevPanel();
  wireDevGesture();

  checkVer();
  requestShellTopUp();

  // iOS home-screen apps RESUME rather than reload.
  addEventListener("visibilitychange", () => {
    if (!document.hidden) { checkVer(); requestShellTopUp(); }
  });
}

boot();
