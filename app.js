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
// Consecutive trail points normally arrive ~0.7 ms apart (16 per message at ~94 Hz). A larger gap
// than this means capture STOPPED and restarted — the gate closed while a note died away, or the
// lock moved — and the phasor is somewhere else entirely by the time it resumes. Joining across
// that draws a chord straight through the middle of the figure, which is what a real G-string
// capture is full of. The trail must break instead: the two arcs are not continuous and drawing
// them as if they were invents a path the signal never took.
const TRAIL_BREAK_MS = 50;

// The Lissajous modes do not produce a trail at all: each message carries a whole CLOSED CURVE
// which replaces the last one, so there is nothing to accumulate. What makes the error readable
// there is the curve's motion between frames, and a single stroke shows none of it — so keep a few
// spaced snapshots and draw them behind, faintest first. The spacing is in TIME, not messages: at
// ~94 messages a second, six consecutive ones span 60 ms and would sit exactly on top of each other.
const CURVE_GHOSTS = 5;
const CURVE_GHOST_MS = 90;

const fig = {
  canvas: null, ctx: null, w: 0, h: 0, dpr: 1,
  kind: 0,                     // 0 = trail (phasor), 1 = closed curve (Lissajous)
  curve: null, curveC: null,   // the current closed curve and the cents that coloured it
  ghosts: [], lastGhost: 0,
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
function trailClear() { fig.head = 0; fig.count = 0; fig.curve = null; fig.ghosts.length = 0; }

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

  // A closed curve REPLACES rather than appends. The worklet says which kind it sent, so this
  // never has to be inferred from the parameter — a message posted before a mode change still
  // renders as whatever it actually is.
  if (m.fk === 1) {
    if (fig.kind !== 1) { trailClear(); fig.kind = 1; }
    if (path && path.length >= 4) {
      if (fig.curve && t - fig.lastGhost > CURVE_GHOST_MS) {
        fig.ghosts.push(fig.curve);
        if (fig.ghosts.length > CURVE_GHOSTS) fig.ghosts.shift();
        fig.lastGhost = t;
      }
      fig.curve = path;
      fig.curveC = m.c;
    }
    return;
  }
  if (fig.kind !== 0) { trailClear(); fig.kind = 0; }
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

// One place that turns a normalized (x, y) into canvas coordinates, shared by both renderers.
// y is negated: the worklet works in maths orientation, the canvas in screen orientation.
function projector() {
  const cx = fig.w / 2, cy = fig.h / 2;
  const R = Math.min(fig.w, fig.h) * 0.34;
  const rot = (Tuner.params.orientation * Math.PI) / 180;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  return {
    x: (x, y) => cx + R * (x * cos - y * sin),
    y: (x, y) => cy - R * (x * sin + y * cos),
  };
}

function strokeCurve(pts, alpha, cents) {
  const ctx = fig.ctx, P = projector();
  const n = pts.length / 2;
  if (n < 2) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = traceColor(cents);
  ctx.beginPath();
  ctx.moveTo(P.x(pts[0], pts[1]), P.y(pts[0], pts[1]));
  for (let i = 1; i < n; i++) ctx.lineTo(P.x(pts[i * 2], pts[i * 2 + 1]), P.y(pts[i * 2], pts[i * 2 + 1]));
  ctx.closePath();                     // it IS a closed curve; leaving the seam open reads as a gap
  ctx.stroke();
}

function drawCurveFrame() {
  const ctx = fig.ctx;
  clearFigure();
  drawGuide(Tuner.engine.lastEstimate ? Tuner.engine.lastEstimate.s : -1);
  if (!fig.curve) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Tuner.params.strokeWidth * fig.dpr;
  for (let i = 0; i < fig.ghosts.length; i++) {
    strokeCurve(fig.ghosts[i], 0.10 + (0.28 * i) / Math.max(1, fig.ghosts.length), fig.curveC);
  }
  strokeCurve(fig.curve, 1, fig.curveC);
  ctx.globalAlpha = 1;
}

// The faint reference the live figure lives ON. One formula covers all three modes:
//
//   x = cos(q*u),  y = sin(p*u)
//
// with p:q = 1:1 for the phasor and the unison Lissajous, and the string's ratio to the reference A
// for mode 2. That gives the phasor's orbit (a unit circle), the widest-open in-tune ellipse, and
// the canonical p:q lattice respectively.
//
// It is deliberately NOT "the shape to match", and no copy may call it that. Being in tune makes the
// figure STATIONARY, not any particular shape: mode 1's in-tune ellipse is anything from a straight
// line to a circle depending on where the phase happened to start, and mode 2's lattice sits at an
// arbitrary rotation. What the guide honestly provides is the centre, the scale, and — in mode 2 —
// the lobe structure to expect. ADDENDUM section 4.
//
// Computed here rather than in the worklet on purpose: it is static geometry from an integer ratio,
// needs no sampleRate and no DSP constant, and posting a second curve on every message to avoid a
// cosine on the main thread would be the wrong trade. The estimation boundary is untouched.
const GUIDE_N = 512;
function drawGuide(stringIdx) {
  if (!Tuner.params.targetGuide) return;
  const ctx = fig.ctx, P = projector();
  const mode = Tuner.params.figureMode | 0;
  let p = 1, q = 1;
  if (mode === 2 && stringIdx >= 0) {
    const r = Tuner.ratios()[stringIdx];
    if (r) { p = r[0]; q = r[1]; }
  }
  ctx.save();
  // --muted at low alpha rather than --line. --line is sized for 1px hairlines against a card and
  // lands about 9% off the background in BOTH themes (#dcdad3 on #f4f3ef, #26302e on #0e1413),
  // which disappears on a phone in daylight. --muted at 0.3 is roughly 16% in both — still clearly
  // subordinate to the trace, still symmetric across themes. Read through getCssColor, never a
  // literal, so a theme switch repaints it correctly.
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = Math.max(1, fig.dpr);
  ctx.strokeStyle = Theme.getCssColor("--muted") || "#8a8a8a";
  ctx.beginPath();
  for (let j = 0; j <= GUIDE_N; j++) {
    const u = (2 * Math.PI * j) / GUIDE_N;
    const x = Math.cos(q * u), y = Math.sin(p * u);
    if (j === 0) ctx.moveTo(P.x(x, y), P.y(x, y));
    else ctx.lineTo(P.x(x, y), P.y(x, y));
  }
  ctx.stroke();
  ctx.restore();
}

function drawFrame() {
  if (!fig.ctx) return;
  if (fig.frozen) return;              // hold the last painted frame, untouched
  if (fig.kind === 1) return drawCurveFrame();
  const ctx = fig.ctx;
  clearFigure();
  // Before the trail check: an empty stage with a reference ring reads as ready, an empty one reads
  // as broken, and that is the difference on every launch.
  drawGuide(Tuner.engine.lastEstimate ? Tuner.engine.lastEstimate.s : -1);
  if (fig.count < 2) return;

  const P = projector();
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

  const sx = (j) => P.x(fig.bx[j], fig.by[j]);
  const sy = (j) => P.y(fig.bx[j], fig.by[j]);

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
    let prevT = fig.bt[j];
    for (let i = a0 + 1; i < a1; i++) {
      j = ringIdx(i);
      const t = fig.bt[j];
      if (t - prevT > TRAIL_BREAK_MS) ctx.moveTo(sx(j), sy(j));   // capture restarted: lift the pen
      else ctx.lineTo(sx(j), sy(j));
      prevT = t;
    }
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
  if (ref >= 0 && !devMode) {
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

  // While the GATE is shut we are reporting nothing, so do not relabel. Room noise between notes is
  // loud enough that the detector's winner wanders — measured on a real G-D-A-E recording, the lock
  // flipped D4/G3 several times in the gaps — and a big letter changing while the player is not
  // playing reads as the app guessing. The lock itself is free to wander; it re-decides within a
  // block or two of the next note. What must not churn is the label, for the same reason the figure
  // freezes rather than decays: hold the last real reading, and show nothing new until there is
  // something new to show.
  if (m.st === 0 && nameEl.textContent && nameEl.textContent !== "—") {
    /* gated: hold whatever the last real reading labelled */
  } else if (m.s >= 0 && m.s < names.length && m.st !== 2) {
    nameEl.textContent = names[m.s];
    el("target-hz").textContent = fmtHz(targets[m.s]) + " Hz";
  } else if (m.st === 2) {
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
  // Dev mode deliberately does NOT suppress the reading while a reference tone sounds — that is
  // the whole point of the loopback test: speaker -> room -> mic -> DSP is the one path the
  // headless suite cannot exercise, and it is the path that produced the open-G misdetection. The
  // label is unmistakable so this can never be read as a measurement of an instrument.
  if (ref >= 0) {
    dirEl.textContent = "loopback · " + Tuner.stringNames()[ref];
    centsEl.classList.remove("sharp", "flat");
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
      wireChip(b, i);
      wrap.appendChild(b);
    });
  }
  const playing = Tuner.referencePlaying();
  const pin = Tuner.pinned();
  names.forEach((n, i) => {
    const chip = wrap.children[i];
    const c = lastByString[i];
    chip.classList.toggle("active", i === activeIdx);
    chip.classList.toggle("playing", i === playing);
    chip.classList.toggle("pinned", i === pin);
    chip.classList.remove("sharp", "flat");
    chip.children[0].textContent = (i === pin ? "📌 " : "") + n;
    chip.title = "Tap to tune only " + n + " · hold to hear it ("
      + fmtHz(Tuner.targets()[i]) + " Hz)";
    if (i === playing) { chip.children[1].textContent = "♪ playing"; return; }
    if (c === undefined) { chip.children[1].textContent = i === pin ? "pinned" : "–"; return; }
    chip.children[1].textContent = fmtCents(c);
    if (Math.abs(c) >= 0.5) chip.classList.add(c > 0 ? "sharp" : "flat");
  });
}

// Tap pins, hold plays. Pinning is the primary action because it is what a player actually needs
// while turning a peg — automatic detection follows whatever is loudest, and when you tune by
// fifths the loudest thing is usually the neighbouring string you are comparing AGAINST. The
// reference tone keeps a home on the same control rather than taking a second slot on a screen
// that has no room for one.
const HOLD_MS = 450;
function wireChip(b, i) {
  let timer = null, held = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  b.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    held = false;
    timer = setTimeout(() => { held = true; timer = null; toggleReference(i); }, HOLD_MS);
  });
  b.addEventListener("pointerup", () => {
    if (timer) { cancel(); togglePin(i); }
    held = false;
  });
  // Leaving the button or a scroll gesture must not fire either action.
  for (const ev of ["pointercancel", "pointerleave"]) b.addEventListener(ev, cancel);
  // A held chip has already acted on pointerup's behalf; swallow the synthetic click so the
  // reference tone is not immediately toggled off again.
  b.addEventListener("click", (e) => { if (held) { e.preventDefault(); e.stopPropagation(); } });
  b.addEventListener("contextmenu", (e) => e.preventDefault());
}

function togglePin(i) {
  const next = Tuner.pinned() === i ? -1 : i;
  Tuner.setPinned(next);
  // Repaint immediately: the estimate stream may be stopped, and a control that does not visibly
  // respond to a tap reads as broken long before the next message would arrive.
  const last = Tuner.engine.lastEstimate;
  paintChips(next >= 0 ? next : last ? last.s : -1);
  if (last) paintEstimate(last);
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
let devMode = false;         // true once the panel exists, however it was opened
let sweepRows = null;        // last loopback sweep, included in Copy diagnostics

function buildDevPanel() {
  devMode = true;
  const panel = el("dev");
  panel.hidden = false;
  // Build it, but open it CLOSED. The panel is fixed to the bottom of the viewport, so leaving it
  // open on load covers the Start button — with ?dev=1 the app could not be started at all, on a
  // phone or anywhere else. The toggle is the only thing on screen until you ask for the rest.
  panel.style.display = "none";

  // A sticky header, because the panel is fixed to the bottom of the viewport and COVERS the pill
  // that opened it — so the pill cannot be used to close it again. Every way out of dev mode has to
  // live inside the panel, and has to stay on screen while the panel scrolls.
  const head = document.createElement("div");
  head.className = "dev-head";
  head.innerHTML = `<b>Dev</b>
    <button type="button" id="dev-exit">Exit dev</button>
    <button type="button" id="dev-close" aria-label="Collapse panel">Collapse</button>`;
  panel.appendChild(head);

  const toggle = document.createElement("button");
  toggle.className = "dev-toggle";
  toggle.textContent = "dev";
  toggle.setAttribute("aria-expanded", "false");
  toggle.onclick = () => setPanelOpen(panel.style.display === "none");
  el("dev-slot").appendChild(toggle);

  // What to actually DO with this panel. It is written for the real situation — standing up,
  // instrument under the chin, phone on a stand — where nobody is going to read a repo to find out
  // which slider to move. Ordered, one action per line, and it names the readout that tells you
  // whether the action worked.
  const guide = document.createElement("details");
  guide.className = "dev-guide";
  guide.open = true;
  guide.innerHTML = `<summary>How to use this panel</summary>
    <ol>
      <li><b>Check it follows you.</b> Bow each open string in turn, a second each. The big letter
        must change to that string within about half a second. Watch the <b>Detection</b> table: the
        string you are bowing should be the <b>0.0 dB</b> row, and the gap to the next row is your
        margin. Under about 3 dB the lock can stick.</li>
      <li><b>If a string is never found</b>, bow it and read its row. Sitting a few dB below the
        winner means detection, not the microphone — lower <em>Lock hysteresis (dB)</em>. Bottom of
        the table with a loud <b>level</b> means the microphone is not getting that string; try
        holding the phone nearer the f-holes, and see <em>Harmonics scored</em>.</li>
      <li><b>If it says “out of range” while you bow</b>, it hears you but cannot place the note.
        Normally that means the string is more than ~150 cents off. The lock now releases itself
        after <em>Unlock after deaf for</em>, so it should recover on its own within a second.</li>
      <li><b>Calibrating the bandwidth</b> — the one number that cannot be derived. Do NOT move the
        slider while bowing: that mixes the parameter change with the bow change, which is how these
        sessions go in circles. Instead: bow one steady note, tap <b>Record 15 s</b>, and it replays
        that same audio in a loop. Now move <em>Demod bandwidth</em> and watch <b>cents SD</b>. Take
        the lowest value where the number stops improving, then check it doesn't drop lock when you
        bow with vibrato live.</li>
      <li><b>Comparing figures.</b> <em>Figure</em> switches between the phasor and two true
        Lissajous modes. 1 is the classic ellipse against this string's own target. 2 draws each
        string's ratio to the reference A — the D string as 2:3, E as 3:2 — and your tuning error
        shows as that shape slowly precessing.</li>
      <li><b>Reporting anything.</b> <b>Copy diagnostics</b> puts the whole state, including the
        detection table and any loopback sweep, on the clipboard. <b>Copy as JS</b> gives just the
        parameters you changed, ready to paste into source.</li>
      <li><b>Leaving.</b> <em>Collapse</em> hides the panel and keeps the pill. <em>Exit dev</em>
        leaves properly and survives a reload; three taps on the build id brings it back.</li>
    </ol>`;
  panel.appendChild(guide);

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
    <div><b id="st-state">–</b><small>state</small></div>
    <div><b id="st-rms">–</b><small>mic rms (raw)</small></div>
    <div><b id="st-amp">–</b><small>demod amp</small></div>`;
  panel.appendChild(stats);

  // The detection table. This is the readout that would have turned "the G string doesn't work"
  // into a one-line diagnosis: it shows every candidate's score, so a string that is sounding but
  // losing the lock is visible AS a number rather than as an absence.
  const det = document.createElement("div");
  det.className = "dev-det";
  det.innerHTML = `<h3>Detection <em>— bow a string; it should be the 0.0 dB row</em></h3>
    <table><thead><tr><th>string</th><th>Hz</th><th>score</th><th>level</th></tr></thead>
    <tbody id="det-body"></tbody></table>`;
  panel.appendChild(det);

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

  const sweep = document.createElement("div");
  sweep.id = "dev-sweep-out";
  sweep.className = "dev-sweep";
  panel.appendChild(sweep);

  const actions = document.createElement("div");
  actions.className = "dev-actions";
  actions.innerHTML = `
    <button type="button" id="dev-sweep">Loopback sweep</button>
    <button type="button" id="dev-copy">Copy diagnostics</button>
    <button type="button" id="dev-js">Copy as JS</button>
    <button type="button" id="dev-rec">Record 15 s</button>
    <button type="button" id="dev-reset">Reset params</button>`;
  panel.appendChild(actions);
  el("dev-sweep").onclick = sweepStrings;
  el("dev-exit").onclick = exitDevMode;
  el("dev-close").onclick = () => setPanelOpen(false);

  const foot = document.createElement("div");
  foot.className = "help";
  foot.style.marginTop = "8px";
  foot.textContent = "Collapse leaves the pill so you can reopen it. Exit dev removes the pill and restores normal behaviour — three taps on the build id brings it back.";
  panel.appendChild(foot);

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
  // The two ABSOLUTE levels, which no readout showed before and which are the first question when
  // nothing happens: is the microphone delivering anything at all (st-rms), and is any of it
  // arriving in the locked string's band (st-amp)? A diagnostics capture that only reports levels
  // RELATIVE to each other cannot distinguish "wrong string" from "silent microphone".
  el("st-rms").textContent = m ? m.n.toFixed(4) : "–";
  el("st-amp").textContent = m ? m.a.toExponential(1) : "–";
  paintDetTable(m);
}

// Per-candidate detection scores, live. `sc` is already in dB relative to the winner, so the row at
// 0.0 is what the detector currently believes and every other row is how far behind it sits — which
// IS the margin the lock hysteresis has to clear.
function paintDetTable(m) {
  const body = el("det-body");
  if (!body) return;
  const names = Tuner.stringNames();
  const t = Tuner.targets();
  const sc = m && m.sc;
  body.innerHTML = names.map((n, i) => {
    const v = sc && sc[i] !== undefined ? sc[i] : null;
    const locked = m && m.s === i;
    // `level` is only meaningful for the string actually locked — it is that string's demodulated
    // amplitude, and there is only one demodulator.
    const lvl = locked && m ? m.a.toExponential(1) : "–";
    return `<tr class="${locked ? "on" : ""}${v !== null && v > -0.05 ? " win" : ""}">
      <td>${n}${locked ? " ●" : ""}</td><td>${fmtHz(t[i])}</td>
      <td>${v === null ? "–" : v.toFixed(1) + " dB"}</td><td>${lvl}</td></tr>`;
  }).join("");
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
    "levels       " + (m ? "mic rms " + m.n.toFixed(4) + "   demod amp " + m.a.toExponential(2)
      + "   gate " + Tuner.params.gateAmp + "   unattributed " + Tuner.params.unattributedRms : "–"),
    "jitter       " + (j === null ? "–" : j.toFixed(4) + " cents SD over 2 s"),
    "lock drops   " + e.stats.lockDrops,
    "gate closes  " + e.stats.gateCloses,
    "messages     " + e.stats.messages,
    "test mode    " + (Tuner.FLAGS.test ? "on, " + Tuner.FLAGS.cents + " cents" : "off"),
    "detection    " + (m && m.sc
      ? names.map((n, i) => n + " " + m.sc[i].toFixed(1) + "dB").join("  ") + "   (0.0 = current winner)"
      : "–"),
    "params       " + JSON.stringify(Tuner.params),
    "non-default  " + JSON.stringify(changedParams()),
  ];
  if (sweepRows) {
    lines.push("loopback     play -> hear | cents | jitter | lock | level(dB rel) | level(abs) | mic rms");
    const peak = Math.max(...sweepRows.map((r) => r.level), 1e-9);
    for (const r of sweepRows) {
      lines.push("             " + r.played + " -> " + r.heard + (r.ok ? "" : "  << MISMATCH")
        + " | " + (r.cents === null ? "-" : fmtCents(r.cents))
        + " | " + (r.jitter === null ? "-" : r.jitter.toFixed(3))
        + " | " + r.lockedPct + "%"
        + " | " + (20 * Math.log10(Math.max(r.level, 1e-9) / peak)).toFixed(1)
        + " | " + r.level.toExponential(2)
        + " | " + r.input.toFixed(4));
    }
  }
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

// ---- loopback sweep ----------------------------------------------------------------
// Play each string's reference tone through the speaker and report what the microphone and the DSP
// made of it. This exercises speaker -> room -> mic -> detector on the real device, which is the
// only way to see the thing that actually broke: a phone mic rolls off steeply low down, so a
// violin G fundamental arrives far weaker than an E, and the detector has to survive that.
//
// It is a real acoustic measurement, so it is affected by room, volume and how you hold the phone.
// Read `level` as a RELATIVE figure across the four rows, not an absolute one.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function sampleFor(ms) {
  return new Promise((res) => {
    const out = [];
    const prev = Tuner.engine.onEstimate;
    Tuner.engine.onEstimate = (m) => { prev(m); out.push({ s: m.s, c: m.c, st: m.st, a: m.a, n: m.n }); };
    setTimeout(() => { Tuner.engine.onEstimate = prev; res(out); }, ms);
  });
}

function summarizeSweep(names, i, hz, samples) {
  const votes = {};
  const cs = [];
  let level = 0, input = 0, locked = 0;
  for (const m of samples) {
    level += m.a || 0; input += m.n || 0;
    if (m.st === 1) {
      locked++;
      votes[m.s] = (votes[m.s] || 0) + 1;
      if (m.c !== null) cs.push(m.c);
    }
  }
  const heard = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
  cs.sort((a, b) => a - b);
  const mean = cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 0;
  const n = samples.length || 1;
  return {
    played: names[i], playedIdx: i, hz: hz,
    heard: heard === undefined ? "—" : names[heard],
    ok: heard !== undefined && Number(heard) === i,
    cents: cs.length ? cs[cs.length >> 1] : null,
    jitter: cs.length > 1 ? Math.sqrt(cs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / cs.length) : null,
    lockedPct: Math.round((100 * locked) / n),
    level: level / n,
    input: input / n,
  };
}

async function sweepStrings() {
  const btn = el("dev-sweep");
  if (!Tuner.engine.running) {
    btn.textContent = "start listening first";
    setTimeout(() => { btn.textContent = "Loopback sweep"; }, 1600);
    return;
  }
  const names = Tuner.stringNames();
  const targets = Tuner.targets();
  const rows = [];
  for (let i = 0; i < names.length; i++) {
    btn.textContent = "Sweeping… " + names[i];
    await Tuner.playReference(i);
    await wait(700);                    // let the cascade and the LSQ window fill
    rows.push(summarizeSweep(names, i, targets[i], await sampleFor(1400)));
    Tuner.stopReference();
    await wait(250);                    // and let it fall silent before the next
  }
  sweepRows = rows;
  onReferenceChange();
  renderSweep(rows);
  btn.textContent = "Loopback sweep";
}

function renderSweep(rows) {
  const out = el("dev-sweep-out");
  if (!out) return;
  const peak = Math.max(...rows.map((r) => r.level), 1e-9);
  const allQuiet = rows.every((r) => r.lockedPct === 0);
  out.innerHTML = `<h3>Loopback <em>— speaker to mic, on this device</em></h3>
    <table><thead><tr><th>play</th><th>hear</th><th>cents</th><th>jit</th><th>lock</th><th>level</th><th>mic</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="${r.ok ? "" : "bad"}">
      <td>${r.played}</td><td>${r.ok ? r.heard : "<b>" + r.heard + "</b>"}</td>
      <td>${r.cents === null ? "–" : fmtCents(r.cents)}</td>
      <td>${r.jitter === null ? "–" : r.jitter.toFixed(2)}</td>
      <td>${r.lockedPct}%</td>
      <td>${(20 * Math.log10(Math.max(r.level, 1e-9) / peak)).toFixed(0)} dB</td>
      <td>${r.input.toFixed(4)}</td>
    </tr>`).join("")}</tbody></table>
    <div class="help">${Tuner.FLAGS.test
      ? "<b>?test=1 is on, so this measured the synthetic oscillator, not the microphone.</b> Every row will mismatch. Reload without ?test=1 for a real loopback."
      : "<b>mic</b> is the raw input RMS — read it FIRST. If it is near zero the microphone heard nothing and every other column is meaningless. <b>level</b> is relative to the loudest row: that column is the microphone's response across the strings. A mismatch in <b>hear</b> with a healthy <b>mic</b> is a detection failure worth reporting."
        + (allQuiet ? "<br><b>Every row is under the gate here.</b> On an iPhone that is expected to some degree: while a microphone stream is live, iOS routes output to the EARPIECE rather than the speaker, so the app can barely hear its own tone — and a bare sine at G3 (196 Hz) is nearly inaudible from a phone speaker anyway. Treat a quiet sweep as a limit of the test, not as a verdict on the microphone; bow the actual instrument and watch <b>mic rms</b> in the panel instead." : "")}</div>`;
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
    // ONE file. This used to emit a .f32 and a .json back to back, and on an installed iOS PWA two
    // downloads in one gesture do not both survive — the audio was the one that got lost, which is
    // the only half that cannot be reconstructed. A WAV carries its own sample rate, plays anywhere,
    // and takes the sidecar with it in a RIFF INFO comment chunk.
    download(wavBlob(data.rec, data.sampleRate, {
      sampleRate: data.sampleRate,
      instrument: Tuner.settings.instrument,
      string: m && m.s >= 0 ? Tuner.stringNames()[m.s] : null,
      stringIndex: m ? m.s : -1,
      refA: Tuner.settings.refA,
      temperament: Tuner.settings.temperament,
      samples: data.rec.length,
      params: Tuner.params,
    }), `tuner-${stamp}.wav`);
    // Replay it immediately: the same audio under whatever parameters you move next.
    Tuner.replay(data.rec, data.sampleRate);
  };
  Tuner.record(15);
}

// Mono 32-bit-float WAV. Float rather than 16-bit PCM because the capture is already float and the
// quiet end is what matters here — a violin G arrives ~30 dB below the D, and requantising it to
// integers to save a file size nobody is paying for would throw away the thing under examination.
function wavBlob(pcm, rate, meta) {
  const comment = JSON.stringify(meta);
  const cBytes = new TextEncoder().encode(comment);
  const cPad = cBytes.length + (cBytes.length % 2);          // RIFF chunks are word-aligned
  const listSize = 4 + 8 + cPad;                             // "INFO" + ICMT header + text
  const dataBytes = pcm.length * 4;
  const size = 4 + (8 + 18) + (8 + 4) + (8 + listSize) + (8 + dataBytes);
  const buf = new ArrayBuffer(8 + size);
  const v = new DataView(buf);
  let o = 0;
  const str = (t) => { for (let i = 0; i < t.length; i++) v.setUint8(o++, t.charCodeAt(i)); };
  const u32 = (n) => { v.setUint32(o, n, true); o += 4; };
  const u16 = (n) => { v.setUint16(o, n, true); o += 2; };

  str("RIFF"); u32(size); str("WAVE");
  // Format 3 = IEEE float. cbSize is present (18-byte fmt) and a `fact` chunk follows, both of
  // which the spec requires for non-PCM and some decoders genuinely check for.
  str("fmt "); u32(18); u16(3); u16(1); u32(rate); u32(rate * 4); u16(4); u16(32); u16(0);
  str("fact"); u32(4); u32(pcm.length);
  str("LIST"); u32(listSize); str("INFO"); str("ICMT"); u32(cBytes.length);
  for (let i = 0; i < cBytes.length; i++) v.setUint8(o++, cBytes[i]);
  if (cPad !== cBytes.length) v.setUint8(o++, 0);
  str("data"); u32(dataBytes);
  for (let i = 0; i < pcm.length; i++) { v.setFloat32(o, pcm[i], true); o += 4; }
  return new Blob([buf], { type: "audio/wav" });
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Leave dev mode completely — not just collapse the panel. Collapsing leaves the pill on screen and
// leaves devMode true, which keeps the reference-tone suppression switched OFF for the rest of the
// session; that is a behaviour change that must not be something you can get stuck in. On an
// installed PWA there is no URL bar to edit and no easy reload, so an in-app exit is the only way
// back out.
function setPanelOpen(open) {
  const panel = el("dev");
  panel.hidden = false;
  panel.style.display = open ? "" : "none";
  const pill = document.querySelector(".dev-toggle");
  if (pill) pill.setAttribute("aria-expanded", String(open));
}

function exitDevMode() {
  devMode = false;
  if (devStatsTimer) { clearInterval(devStatsTimer); devStatsTimer = null; }
  sweepRows = null;
  Tuner.stopReference();

  const panel = el("dev");
  panel.innerHTML = "";              // emptied, so the gesture below rebuilds it fresh
  panel.hidden = true;
  panel.style.display = "";
  const pill = document.querySelector(".dev-toggle");
  if (pill) pill.remove();

  // Make the exit survive a reload. Dev mode is ON by default until the first release, so this now
  // has to WRITE ?dev=0 rather than delete the flag — deleting it would re-enable dev on the next
  // launch and "exit" would look broken, which is the same failure in the opposite direction.
  try {
    const u = new URL(location.href);
    u.searchParams.set("dev", "0");
    history.replaceState(null, "", u);
  } catch (e) { /* history unavailable */ }

  onReferenceChange();               // restore the non-dev readout state
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
    setPanelOpen(el("dev").style.display === "none");
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
