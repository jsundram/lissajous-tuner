// tuner.js — audio graph, detection state, and the parameter table. Main thread only.
//
// The division of labour (ADDENDUM section 1): this file OWNS the graph, the user's choices and
// the parameters; tuner-worklet.js owns every piece of DSP. Estimates arrive render-ready, so
// nothing here needs sampleRate or a filter coefficient. Keep it that way — the moment this file
// starts doing arithmetic on phase, there are two sources of truth again.
(function (root) {
  "use strict";

  // ---- the parameter table --------------------------------------------------
  // ONE declarative object: default, range, step and class per parameter. The ?dev=1 panel is
  // GENERATED from this, so adding a knob is one line and the defaults have a single home. This is
  // also what gets posted to the worklet as `config`, which makes this table authoritative and the
  // worklet's own DEFAULTS merely a fallback for the headless tests.
  //
  // The split is the point, and the two halves get different treatment:
  //
  //   "taste"   — free to fiddle; CANNOT produce a wrong reading. These ship, and persist.
  //   "measure" — changes what the app REPORTS. These have right answers that do not depend on
  //               taste, so they get calibrated against a real instrument and then BAKED IN. A
  //               tuner that lets you drag its bandwidth is a tuner that can quietly lie to you.
  const PARAMS = {
    // --- taste ---------------------------------------------------------------
    trailAlpha:     { def: 0.03, min: 0.005, max: 0.12,  step: 0.005, cls: "taste",
                      label: "Trail decay", unit: "alpha", help: "Higher = shorter trail. 0.03 is about a 0.8 s tail." },
    overlayWeight:  { def: 0.4,  min: 0,     max: 1,     step: 0.05,  cls: "taste",
                      label: "Overtone mix", unit: "x", help: "Weight of the 2*f0 phasor in the figure. Shape reads as timbre, not tuning." },
    strokeWidth:    { def: 2.5,  min: 0.5,   max: 8,     step: 0.5,   cls: "taste",
                      label: "Stroke width", unit: "px", help: "" },
    orientation:    { def: 0,    min: -180,  max: 180,   step: 5,     cls: "taste",
                      label: "Figure rotation", unit: "deg", help: "Cosmetic. Rotates the whole figure." },
    hueByError:     { def: 1,    min: 0,     max: 1,     step: 1,     cls: "taste",
                      label: "Colour by error sign", unit: "0/1", help: "Tint the trace sharp/flat instead of a single colour." },
    releaseSec:     { def: 1.5,  min: 0.2,   max: 5,     step: 0.1,   cls: "taste", worklet: true,
                      label: "Follower release", unit: "s", help: "How slowly the radius gives up as a note decays." },
    attackSec:      { def: 0.02, min: 0.005, max: 0.2,   step: 0.005, cls: "taste", worklet: true,
                      label: "Follower attack", unit: "s", help: "" },
    overlayGateCents:{ def: 25,  min: 5,     max: 60,    step: 5,     cls: "taste", worklet: true,
                      label: "Overlay gate", unit: "cents", help: "Past this the 2*f0 phasor undersamples; drop it from the figure." },

    // --- measurement ---------------------------------------------------------
    bwCoef:         { def: 0.06, min: 0.01,  max: 0.20,  step: 0.005, cls: "measure", worklet: true,
                      label: "Demod bandwidth / f0", unit: "x",
                      help: "The one number in the plan that can't be derived. Too wide: the figure jitters from partial bleed. Too narrow: lock drops under vibrato. Sweep it against a real bowed note and take the lowest value whose jitter stops improving." },
    lsqSec:         { def: 0.5,  min: 0.1,   max: 2.0,   step: 0.05,  cls: "measure", worklet: true,
                      label: "Slope window", unit: "s",
                      help: "Least-squares window for dtheta/dt. Longer = steadier reading, slower to settle." },
    gateAmp:        { def: 0.0012, min: 0.0001, max: 0.02, step: 0.0001, cls: "measure", worklet: true,
                      label: "Noise gate", unit: "amp",
                      help: "Below this the figure freezes and dims. Too low and it reads a stale figure as in-tune." },
    hystDb:         { def: 6,    min: 0,     max: 20,    step: 1,     cls: "measure", worklet: true,
                      label: "Lock hysteresis", unit: "dB",
                      help: "A new string must beat the locked one by this much before the lock moves." },
    hystBlocks:     { def: 3,    min: 1,     max: 10,    step: 1,     cls: "measure", worklet: true,
                      label: "Lock hysteresis", unit: "blocks",
                      help: "...and for this many consecutive blocks. Bow noise on attack can briefly beat the score; this is the mitigation." },
    detH2Weight:    { def: 0,    min: 0,     max: 1,     step: 0.05,  cls: "measure", worklet: true,
                      label: "Octave probe weight", unit: "x",
                      help: "DANGEROUS above 0. Strings are fifths, so 2*G2 = 3*C2 exactly: an octave probe lands on the third partial of the string below. Only for a cello whose fundamental the mic has rolled off." },
    outOfRangeCents:{ def: 120,  min: 50,    max: 300,   step: 10,    cls: "measure", worklet: true,
                      label: "Refuse to report past", unit: "cents",
                      help: "Past 100 cents the detection band means we may be locked to the wrong string, so a number is unjustifiable." },
  };

  const WORKLET_KEYS = Object.keys(PARAMS).filter((k) => PARAMS[k].worklet);
  const defaults = () => {
    const o = {};
    for (const k in PARAMS) o[k] = PARAMS[k].def;
    return o;
  };

  // ---- persisted settings ----------------------------------------------------
  const SETTINGS_KEY = "lt-settings";
  const VIZ_KEY = "lt-viz";

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? Object.assign({}, fallback, JSON.parse(raw)) : Object.assign({}, fallback);
    } catch (e) { return Object.assign({}, fallback); }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  // ---- URL flags --------------------------------------------------------------
  const Q = new URLSearchParams(location.search);
  const FLAGS = {
    dev: Q.get("dev") === "1",
    test: Q.get("test") === "1",
    // Self-test: swap the mic for a synthetic tone this many cents off the target. The anchor is
    // 3.93 cents at A440 = exactly 1.000 Hz of beat = one revolution of the figure per second.
    cents: Q.has("cents") ? parseFloat(Q.get("cents")) : 3.93,
    string: Q.has("string") ? parseInt(Q.get("string"), 10) : null,
    partials: Q.has("partials") ? parseInt(Q.get("partials"), 10) : 3,
  };

  // ---- engine -----------------------------------------------------------------
  const engine = {
    ctx: null, node: null, gain: null, source: null, stream: null,
    running: false, wakeLock: null,
    settings: load(SETTINGS_KEY, { instrument: "violin", refA: 440, temperament: "pure" }),
    params: load(VIZ_KEY, defaults()),
    onEstimate: null,      // set by app.js
    onStatus: null,        // (kind, detail) for real UI on real failures
    lastEstimate: null,
    // diagnostics, for the dev panel and the Copy-diagnostics button
    stats: { lockDrops: 0, gateCloses: 0, messages: 0, lastState: null, centsWindow: [] },
  };

  function targets() {
    return root.Strings.targets(engine.settings.instrument, engine.settings.refA, engine.settings.temperament);
  }
  function stringNames() {
    return root.Strings.INSTRUMENTS[engine.settings.instrument].names;
  }

  function workletConfig() {
    const c = {};
    for (const k of WORKLET_KEYS) c[k] = engine.params[k];
    return c;
  }

  // Push targets to the worklet. A CHANGE resets the lock (and therefore the demodulator phase);
  // an identical list deliberately does not, so a redundant call cannot jerk the figure.
  function pushTargets() {
    if (!engine.node) return;
    engine.node.port.postMessage({ type: "targets", freqs: targets() });
  }
  function pushConfig() {
    if (!engine.node) return;
    engine.node.port.postMessage({ type: "config", values: workletConfig() });
  }

  // ---- sources -----------------------------------------------------------------
  // Kill Safari's DSP chain. All three are ON by default there, and automatic gain control in
  // particular destroys phase coherence — which is the entire signal this app measures.
  const MIC_CONSTRAINTS = {
    audio: {
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
      channelCount: 1,
    },
    video: false,
  };

  async function micSource(ctx) {
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    engine.stream = stream;
    return ctx.createMediaStreamSource(stream);
  }

  // Claude Code cannot bow a violin, so ship a synthetic instrument. Partials at -6 and -12 dB
  // make it a fairer stand-in for a bowed string than a bare sine.
  function testSource(ctx) {
    const t = targets();
    const idx = FLAGS.string !== null ? FLAGS.string
      : Math.min(t.length - 1, engine.settings.instrument === "violin" ? 2 : 3);   // the A string
    const f = t[idx] * Math.pow(2, FLAGS.cents / 1200);
    const mix = ctx.createGain();
    mix.gain.value = 1;
    const levels = [0.3, 0.15, 0.075];       // 0, -6, -12 dB
    for (let k = 1; k <= Math.max(1, FLAGS.partials); k++) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f * k;
      const g = ctx.createGain();
      g.gain.value = levels[k - 1] !== undefined ? levels[k - 1] : 0.05;
      osc.connect(g).connect(mix);
      osc.start();
    }
    engine.testInfo = { index: idx, target: t[idx], freq: f, cents: FLAGS.cents };
    return mix;
  }

  // ---- lifecycle ----------------------------------------------------------------
  async function start() {
    if (engine.running) return;
    // Read the rate off the context; NEVER hardcode 44100. iOS gives 48k on newer devices and can
    // drop the mic path to 16k or 8k under some constraint combinations.
    const ctx = new (root.AudioContext || root.webkitAudioContext)();
    engine.ctx = ctx;

    // addModule must complete BEFORE the node is constructed.
    await ctx.audioWorklet.addModule("./tuner-worklet.js");

    engine.node = new AudioWorkletNode(ctx, "tuner", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { targets: targets(), config: workletConfig() },
    });
    engine.node.port.onmessage = (e) => {
      if (e.data && e.data.rec) { if (engine.onRecording) engine.onRecording(e.data); return; }
      handleEstimate(e.data);
    };

    try {
      engine.source = FLAGS.test ? testSource(ctx) : await micSource(ctx);
    } catch (err) {
      // Real UI, not a console message. NotAllowedError is the common one (permission denied);
      // NotFoundError means no input device at all.
      if (engine.onStatus) engine.onStatus("micerror", err && err.name ? err.name : String(err));
      throw err;
    }
    engine.source.connect(engine.node);

    // The zero-gain path to destination is REQUIRED, not decorative: an AudioWorkletNode whose
    // output is unconnected is not pulled by the graph on Safari, and process() silently stops
    // being called. Gain must be 0 or the mic feeds back through the speaker.
    engine.gain = ctx.createGain();
    engine.gain.gain.value = 0;
    engine.node.connect(engine.gain).connect(ctx.destination);

    await ctx.resume();          // requires a user gesture; the Start button is that gesture
    engine.running = true;
    requestWakeLock();
    if (engine.onStatus) engine.onStatus("running", { sampleRate: ctx.sampleRate });
  }

  async function stop() {
    engine.running = false;
    releaseWakeLock();
    if (engine.stream) { engine.stream.getTracks().forEach((t) => t.stop()); engine.stream = null; }
    if (engine.ctx) { try { await engine.ctx.close(); } catch (e) { /* already closed */ } engine.ctx = null; }
    engine.node = null; engine.source = null; engine.gain = null;
  }

  function handleEstimate(m) {
    const s = engine.stats;
    s.messages++;
    // Lock drops and gate closes are EDGES, not levels — counting levels would just count frames.
    if (s.lastState !== null) {
      if (m.s !== engine.lastEstimate?.s && m.s >= 0 && engine.lastEstimate?.s >= 0) s.lockDrops++;
      if (m.st === 0 && s.lastState !== 0) s.gateCloses++;
    }
    s.lastState = m.st;
    // Rolling 2 s of cents for the jitter readout (~94 messages/s).
    if (m.c !== null) {
      s.centsWindow.push(m.c);
      if (s.centsWindow.length > 188) s.centsWindow.shift();
    }
    engine.lastEstimate = m;
    if (engine.onEstimate) engine.onEstimate(m);
  }

  // Standard deviation of cents over the rolling window — the number that turns bandwidth tuning
  // from an eyeball into a measurement.
  function jitter() {
    const w = engine.stats.centsWindow;
    if (w.length < 8) return null;
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    return Math.sqrt(w.reduce((a, b) => a + (b - mean) * (b - mean), 0) / w.length);
  }

  // ---- wake lock -------------------------------------------------------------
  // Dropped on backgrounding, so it must be re-requested on visibilitychange — otherwise the
  // screen dies mid-tune the first time you look away.
  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      engine.wakeLock = await navigator.wakeLock.request("screen");
      engine.wakeLock.addEventListener("release", () => { engine.wakeLock = null; });
    } catch (e) { /* denied or unsupported: not fatal */ }
  }
  function releaseWakeLock() {
    if (engine.wakeLock) { try { engine.wakeLock.release(); } catch (e) {} engine.wakeLock = null; }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && engine.running && !engine.wakeLock) requestWakeLock();
  });

  // ---- settings mutation -------------------------------------------------------
  function setSetting(key, value) {
    engine.settings[key] = value;
    save(SETTINGS_KEY, engine.settings);
    pushTargets();                       // a real change resets the lock; an identical list doesn't
  }
  function setParam(key, value) {
    engine.params[key] = value;
    save(VIZ_KEY, engine.params);
    if (PARAMS[key] && PARAMS[key].worklet) pushConfig();
  }
  function resetParams() {
    engine.params = defaults();
    save(VIZ_KEY, engine.params);
    pushConfig();
  }

  // ---- dev: record and replay ---------------------------------------------------
  // Do NOT adjust parameters live while bowing: that conflates the parameter change with the bow
  // change, which is how these sessions go in circles. Capture once, then replay the SAME audio
  // under different parameters.
  function record(seconds) {
    if (!engine.node) return false;
    engine.node.port.postMessage({ type: "record", on: true, seconds: seconds });
    return true;
  }
  function stopRecording() {
    if (engine.node) engine.node.port.postMessage({ type: "record", on: false });
  }

  // Swap the live source for a looping buffer. The worklet is untouched, so every DSP parameter
  // stays variable under replay.
  function replay(pcm, rate) {
    if (!engine.ctx || !engine.node) return;
    if (engine.source) { try { engine.source.disconnect(); } catch (e) {} }
    if (engine.stream) { engine.stream.getTracks().forEach((t) => t.stop()); engine.stream = null; }
    const buf = engine.ctx.createBuffer(1, pcm.length, rate || engine.ctx.sampleRate);
    buf.copyToChannel(pcm, 0);
    const src = engine.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(engine.node);
    src.start();
    engine.source = src;
    engine.replaying = true;
  }

  root.Tuner = {
    PARAMS, FLAGS, engine, defaults,
    start, stop, targets, stringNames, jitter, record, stopRecording, replay,
    setSetting, setParam, resetParams, pushTargets, pushConfig,
    get settings() { return engine.settings; },
    get params() { return engine.params; },
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
