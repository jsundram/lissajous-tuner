// tuner-worklet.js — ALL of the DSP, and the single source of truth for it.
//
// Per ADDENDUM section 1 the estimation boundary is here, not on the main thread: detection,
// demodulation, phase unwrap, slope estimation, the amplitude follower and gating all run in this
// file, and it posts render-ready numbers. The main thread draws and nothing else — it never needs
// `sampleRate` or any constant below. tests/ runs this exact file under `vm`, so there is no
// second copy of the math to drift.
//
// The chain, per 128-sample quantum:
//
//   mic ──┬─ Goertzel bank over the 4 candidate strings ─────────── which string? (coarse)
//         │
//         └─ quadrature demodulate at f0 and 2*f0 ── 4-pole LPF ──── phase (fine)
//                                                        │
//                    unwrap at QUANTUM rate ─── least-squares slope over 0.5 s ─── cents
//
// Why not an FFT: `AnalyserNode` discards phase, and phase IS the signal. FFT resolution is capped
// by window length; watching a phase difference drift is not. Reference and signal are generated in
// the same AudioContext at the same sampleRate, so there is no clock drift between them — which is
// otherwise the accuracy ceiling.

const QUANTUM = 128;        // AudioWorklet render quantum, fixed by the spec
const MSG_EVERY = 4;        // post every 4th quantum: 512 samples, ~10.7 ms, ~94 Hz

// Phase unwrapping fails when the phasor moves more than pi between samples, so the unwrap rate
// sets a hard ceiling on the error we can measure: rate/(2*stride) Hz.
//
// ADDENDUM section 3 says to unwrap once per QUANTUM, "which raises the ceiling to ~187 Hz". That
// is the 48 kHz figure, and the quantum is a fixed 128 SAMPLES rather than a fixed duration — so
// the ceiling scales with the sample rate and collapses to 62.5 Hz on the 16 kHz mic path iOS can
// hand us. 250 cents flat at E5 is 88.4 Hz, which duly folded over and reported +92.6 cents: a
// small, plausible, wrong number, the exact failure that section exists to prevent.
//
// Unwrapping every 32 samples instead decouples the ceiling from the quantum: 250 Hz at 16k,
// 750 Hz at 48k, past any real error at any rate the platform can give us.
const UNWRAP_STRIDE = 32;

// How many geometry points ride on each message. The estimate only needs one — I/Q are bandlimited
// to the capture bandwidth, so decimating to ~94 Hz is legitimate for MEASUREMENT. But the figure
// is a PATH, and at a 5 Hz beat 94 Hz gives ~18 points per revolution, which draws as a visible
// polygon rather than a curve. The phasor is already evaluated every UNWRAP_STRIDE samples for the
// unwrapper, so those points are free: sending all of them is 16x the path resolution for 128
// bytes a message. The plan called the raggedness "acceptable"; it did not need to be.
const PATH_PER_MSG = MSG_EVERY * (QUANTUM / UNWRAP_STRIDE);   // 16

// The Lissajous modes send a whole CLOSED CURVE per message rather than a trail segment, so the
// point count is set by how many lobes the curve has: a violin G against the reference A is 4:9 and
// needs far more points than the 1:1 ellipse to avoid drawing as a polygon.
const FIG_N_PER_CYCLE = 32, FIG_N_MIN = 96, FIG_N_MAX = 320;
const LPF_SECTIONS = 4;     // ADDENDUM section 2 — a single pole is not enough (see CASCADE_SCALE)

// Cascading N identical one-poles NARROWS the composite response: for N=4 the -3 dB point sits at
// 0.435x the per-section cutoff. Scale the per-section cutoff up by 1/0.435 to preserve the capture
// range `bw` actually asks for. Skip this and the capture range silently halves, which reads as a
// twitchy lock on a flat string and sends you chasing the bandwidth knob instead.
const CASCADE_SCALE = 2.3;

// Time constants of settling to wait after the demodulator is reset before believing its output.
// Every string change zeroes the cascade, so this is also what stops a wrong number flashing on
// screen at the moment the lock moves.
const SETTLE_TC = 8;

// Detection block sizing. The plan fixed this at 1024 samples (~47 Hz at 48k), which is fine for
// violin (closest pair G3->D4, 97.8 Hz) but NOT for cello: C2 and G2 are only 32.6 Hz apart, so a
// 47 Hz bin cannot separate them at any hysteresis setting. Size the block from the actual
// candidate spacing instead — that fixes cello and handles the 16 kHz mic path for free.
const DETECT_BINS_PER_GAP = 2.5;   // resolution must be this much finer than the closest pair
const DETECT_N_MIN = 1024, DETECT_N_MAX = 8192;

// Each candidate is scored over a BAND, not at a single bin: the best Goertzel power across probes
// spanning +-DETECT_BAND_CENTS of its fundamental. This resolves a conflict the plan leaves open.
// A single bin cannot satisfy both requirements at once — detection must stay flat over the +-100
// cents a badly out-of-tune string can sit at (39 Hz at E5, so bins must be WIDE), while cello C2
// and G2 are only 32.6 Hz apart (so bins must be NARROW). At 16k a single-bin score put an 80-cent
// flat E5 two bins off its own fundamental, in a sidelobe, scoring near zero.
//
// Probing a band decouples them: bins stay narrow enough to separate C2 from G2, and the band
// gives a flat capture wider than the +-100 cents the plan asks for.
//
// A band cannot collide with a NEIGHBOUR'S BAND: consecutive strings are a fifth apart = 702
// cents, so any half-width below 351 keeps them disjoint. But it can absolutely collide with a
// neighbour's PARTIALS, and at +-300 cents it did: E5's band was 555-785 Hz, which contains G3's
// 3rd and 4th partials (587 and 782 Hz). On a real violin the G string's fundamental is weak — the
// body barely radiates 196 Hz and phone mics roll off there — so those partials beat it and an
// open G read as E5. +-150 still covers +-100 and catches none of them.
const DETECT_BAND_CENTS = 150;
const DETECT_OFFSETS_MAX = 48;     // probe positions across the band; a ceiling on the per-block cost

// ...and scoring the fundamental ALONE is what made that collision fatal. Score the harmonic
// SERIES instead: sum the band peak at k*f0 for k = 1..detHarmonics, weighted 1/k. A string whose
// fundamental the mic has rolled off still wins on its own partials, because every one of them
// lands on one of ITS harmonics while only one or two land on anyone else's.
//
// This is the principled version of the 2*f0 term tried and rejected earlier. That one gave a
// candidate credit for a SINGLE octave probe, which for fifth-spaced strings lands exactly on the
// third partial of the string below (2*G2 = 3*C2). Requiring the whole series to line up removes
// the degeneracy: a wrong candidate collects one or two partials, the right one collects all of
// them.
const DETECT_HARMONICS = 4;

// ...but only if the series is required to line up at ONE offset. Taking an independent maximum
// inside each harmonic's band does not require that, and it is why the lock used to stick: every
// candidate got to pick, per harmonic, whichever nearby foreign partial happened to be loudest.
//
// Measured on cello C2, scoring a bowed C2: D3's k=1 band is 134-160 Hz and its BOTTOM PROBE sits
// 3 Hz from C2's second partial at 130.8 — inside one 11.7 Hz bin, so it collected essentially all
// of it (43 dB, against C2's own 44 dB total). D3 then trailed the correct answer by 1.0 dB while
// hystDb demanded 6, so a cellist could bow D3 forever and the readout stayed on C2. Nine of the
// twelve string-to-string transitions were below the threshold; a real violin sweep of G-D-A-E
// reported "G3" for all four notes.
//
// A string mistuned by d cents shifts EVERY harmonic by exactly d cents. So probe a COMB: evaluate
// all k harmonics at one shared offset, combine, and take the best offset. A wrong candidate now
// has to find foreign partials that line up at a single consistent offset, which the fifths do not
// provide.
//
// The comb alone was worth only ~0.5 dB, because the leak above is not an offset inconsistency —
// it is BIN WIDTH. +-150 cents at cello D3 is +-12.7 Hz and the bins are 11.7 Hz wide, so the band
// plus one mainlobe bridges the whole 16 Hz gap to C2's second partial. No offset, window or band
// width fixes that; only a longer block would, and 0.34 s blocks make string changes visibly slow.
//
// What does fix it is HOW the comb is combined. A sum lets one huge term carry a candidate: D3's
// score was essentially "C2's second partial, alone". Take the GEOMETRIC mean of the harmonic
// powers instead, with an explicit penalty for each harmonic that is not there at all. Every member
// then has to be present, which is exactly the claim "these partials belong to that string".
//
// Flat weights, not 1/k. The 1/k weighting was the arithmetic sum's way of stopping a high partial
// from dominating; in a geometric mean nothing dominates, and weighting the fundamental up simply
// reinstates the rolled-off-fundamental failure. Every harmonic counts once, because the question
// is whether it is THERE, not how loud it is.
//
// Three constants, each earning its place against a measured failure:
//
//   FLOOR_REL is ABSOLUTE — a fraction of the block's own energy, not of the candidate's own peak.
//   Flooring relative to the candidate compares floors when the signal is a pure sine with no
//   partials at all, and a 440 Hz sine duly locked G3 (whose k=2 band edge at 426 Hz is 0.6 bins
//   away) instead of A4. A tuning fork, or the app's own reference tone, must not do that.
//
//   MISS_PEN is what actually separates a real series from a lucky collision, because the
//   geometric mean alone compresses everything through a 1/kMax root.
//
//   MISS_PEN_F0 is extra penalty for a missing FUNDAMENTAL, which is the one thing that tells A4
//   from G3 on a pure 440 Hz tone. It is deliberately mild: a violin G string's fundamental really
//   is missing on a phone mic, and that case has to keep winning. 0.5 buys the pure tone 3 dB and
//   still leaves the rolled-off G string 9 dB clear.
//
// Measured worst-case margin over the full instrument x string matrix at 16/44.1/48 kHz, clean and
// with room noise: bowed strings 1.6 -> 9.4 dB, reference tone 11.5 dB, pure sine 3.6 dB.
const DETECT_FLOOR_REL = 0.01;      // a harmonic is "not there" below -20 dB of the block's energy
const DETECT_MISS_PEN = 0.25;       // ...and each absent harmonic costs the candidate 6 dB
const DETECT_MISS_PEN_F0 = 0.5;     // ...doubled to 12 dB when the absent one is the fundamental

// Defaults. The main thread owns the authoritative copy of this table (tuner.js PARAMS, which is
// what the ?dev=1 panel is generated from) and posts it as a `config` message at startup; these are
// the fallbacks that make the worklet runnable on its own, which is how tests/ drives it.
const DEFAULTS = {
  // --- measurement: changes what the app REPORTS ---
  bwCoef: 0.06,             // capture bandwidth as a fraction of f0
  bwMin: 6, bwMax: 45,      // Hz, clamps on the above
  lsqSec: 0.5,              // least-squares slope window
  hystDb: 3, hystBlocks: 3, // a new string must beat the locked one by this much, this many times
  unlockSec: 0.25,          // ...but a lock that hears NOTHING while the room is loud is dropped
                            //    outright after this long (see emit)
  gateAmp: 0.0012,          // demodulated magnitude below which we refuse to report (noise floor)
  detHarmonics: DETECT_HARMONICS,   // harmonics summed per candidate (see above)
  // Raw input RMS above which a closed gate means "I hear something I cannot attribute to a
  // string" (st 3) rather than "silence" (st 0). A string more than ~150 cents off falls outside
  // every candidate's detection band, so whatever we lock will see nothing through its narrow
  // demodulator — and reporting "listening" there is misleading when the player is bowing hard.
  unattributedRms: 0.02,
  outOfRangeCents: 120,     // beyond this: st 3, and NO cents value (ADDENDUM section 3)
  h2EnterCents: 20,         // use the 2*f0 phasor as the primary estimate inside this...
  h2ExitCents: 25,          // ...and fall back outside this (hysteresis, so it cannot chatter)
  h2MinRel: 0.15,           // ...and only if the 2*f0 partial is at least this strong vs f0
  h2BlendSec: 0.35,         // crossfade time between the two estimates, so the number never jumps
  figureMode: 0,            // 0 phasor, 1 Lissajous vs this string, 2 Lissajous vs the reference A
  // --- taste: cannot produce a wrong reading ---
  overlayWeight: 0.4,       // the 0.4 in x = i1 + 0.4*i2
  overlayGateCents: 25,     // above this the 2*f0 phasor undersamples; drop it from the figure
  attackSec: 0.02,          // amplitude follower: fast attack...
  releaseSec: 1.5,          // ...slow release, so the figure holds radius as the note decays
};

// ---- least-squares slope over a sliding window -----------------------------
// Estimating dtheta/dt by differencing consecutive samples is dominated by noise. This is the
// slope of a line fit over the whole window, maintained in O(1).
//
// The window's x values are always 0..n-1, so Sx and Sxx are constants and only Sy and Sxy move.
// Dropping the oldest sample shifts every index down by one, which gives:
//   Sxy' = Sxy + n*yNew - Sy + yOld - yNew        (Sy here is the OLD Sy — order matters)
//   Sy'  = Sy - yOld + yNew
// Keeping x window-relative rather than absolute matters: with an absolute sample index the
// n*Sxy - Sx*Sy numerator loses its significant digits to cancellation within an hour of running.
class Slope {
  constructor(n) {
    this.n = n;
    this.buf = new Float64Array(n);
    this.count = 0; this.head = 0;
    this.Sy = 0; this.Sxy = 0;
    this.Sx = (n * (n - 1)) / 2;
    this.Sxx = ((n - 1) * n * (2 * n - 1)) / 6;
    this.den = n * this.Sxx - this.Sx * this.Sx;
  }
  push(y) {
    const n = this.n;
    if (this.count < n) {                      // still filling
      this.buf[this.count] = y;
      this.Sy += y;
      this.Sxy += this.count * y;
      this.count++;
      return;
    }
    const yOld = this.buf[this.head];
    this.Sxy = this.Sxy + n * y - this.Sy + yOld - y;   // uses the pre-update Sy, per above
    this.Sy = this.Sy - yOld + y;
    this.buf[this.head] = y;
    this.head = (this.head + 1) % n;
  }
  get full() { return this.count >= this.n; }
  // Slope in y-units per sample. During fill the window is short, so recompute directly — it is
  // O(n) but happens only for the first `n` pushes of a lock.
  slope() {
    if (this.count < 2) return 0;
    if (this.count < this.n) {
      let Sx = 0, Sy = 0, Sxy = 0, Sxx = 0;
      for (let k = 0; k < this.count; k++) {
        const y = this.buf[k];
        Sx += k; Sy += y; Sxy += k * y; Sxx += k * k;
      }
      const den = this.count * Sxx - Sx * Sx;
      return den === 0 ? 0 : (this.count * Sxy - Sx * Sy) / den;
    }
    return this.den === 0 ? 0 : (this.n * this.Sxy - this.Sx * this.Sy) / this.den;
  }
  reset() { this.buf.fill(0); this.count = 0; this.head = 0; this.Sy = 0; this.Sxy = 0; }
}

// ---- one quadrature demodulator --------------------------------------------
// Multiply by a local sin/cos pair at `freq`, lowpass both legs. The resulting vector's ANGLE is
// the phase offset; its ROTATION RATE is the frequency error in Hz.
class Demod {
  constructor(rate) { this.rate = rate; this.i = new Float64Array(LPF_SECTIONS); this.q = new Float64Array(LPF_SECTIONS); this.p = 0; this.w = 0; this.a = 0; }
  tune(freq, bw) {
    this.w = (2 * Math.PI * freq) / this.rate;
    const fc = CASCADE_SCALE * bw;                       // per-section cutoff (see CASCADE_SCALE)
    this.a = 1 - Math.exp((-2 * Math.PI * fc) / this.rate);
  }
  reset() { this.i.fill(0); this.q.fill(0); this.p = 0; }
  // Run `len` samples starting at `off`. Kept as one tight loop: this is the only per-sample work.
  run(block, off, len) {
    const { i, q } = this;
    const a = this.a, w = this.w;
    let p = this.p;
    for (let n = off; n < off + len; n++) {
      const x = block[n];
      let vi = x * Math.cos(p);
      let vq = -x * Math.sin(p);
      for (let k = 0; k < LPF_SECTIONS; k++) { i[k] += a * (vi - i[k]); vi = i[k]; }
      for (let k = 0; k < LPF_SECTIONS; k++) { q[k] += a * (vq - q[k]); vq = q[k]; }
      p += w;
      if (p >= 2 * Math.PI) p -= 2 * Math.PI;            // keep p bounded; float precision otherwise
      else if (p < 0) p += 2 * Math.PI;                   // decays over a long session
    }
    this.p = p;
  }
  get I() { return this.i[LPF_SECTIONS - 1]; }
  get Q() { return this.q[LPF_SECTIONS - 1]; }
  get mag() { return Math.hypot(this.I, this.Q); }
}

// ---- phase unwrapper -------------------------------------------------------
// Unwrapping fails when the phasor moves more than pi between samples. At the 94 Hz MESSAGE rate
// that caps the trackable error at 47 Hz — but 100 cents at E5 is 39 Hz, so a string a whole tone
// flat would alias and report a small, plausible, WRONG number. Unwrapping at the QUANTUM rate
// (375 Hz at 48k) raises the ceiling to ~187 Hz, past any real error. ADDENDUM section 3.
class Unwrap {
  constructor() { this.prev = 0; this.acc = 0; this.started = false; }
  push(th) {
    if (!this.started) { this.prev = th; this.started = true; return this.acc; }
    let d = th - this.prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    this.acc += d;
    this.prev = th;
    return this.acc;
  }
  reset() { this.prev = 0; this.acc = 0; this.started = false; }
}

// ---- Goertzel ---------------------------------------------------------------
// Magnitude-squared at one frequency over a block. Cheaper than an FFT and we only want 8 bins.
function goertzelPower(buf, len, coeff) {
  let s1 = 0, s2 = 0;
  for (let n = 0; n < len; n++) {
    const s = buf[n] + coeff * s1 - s2;
    s2 = s1; s1 = s;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

class TunerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.rate = sampleRate;
    this.cfg = Object.assign({}, DEFAULTS, opts.config || {});
    this.targets = opts.targets || [];       // candidate fundamentals, low to high
    this.ratios = opts.ratios || [];         // integer f0:refA per string (figureMode 2)
    this.quantaPerSec = this.rate / QUANTUM;
    this.unwrapPerSec = this.rate / UNWRAP_STRIDE;   // the rate the unwrapper and LSQ actually run at

    this.d1 = new Demod(this.rate);          // f0
    this.d2 = new Demod(this.rate);          // 2*f0
    this.u1 = new Unwrap();
    this.u2 = new Unwrap();
    const lsqN = Math.max(4, Math.round(this.cfg.lsqSec * this.unwrapPerSec));
    this.s1 = new Slope(lsqN);
    this.s2 = new Slope(lsqN);

    this.locked = -1;                        // index into targets, -1 = searching
    this.pinned = -1;                        // user-chosen string; -1 = detect automatically
    this.cand = -1; this.candRuns = 0;       // hysteresis state
    this.env = 0;                            // amplitude follower
    this.blend = 0;                          // 0 = f0 estimate, 1 = 2*f0 estimate
    this.useH2 = false;
    this.quantum = 0;
    this.rec = null; this.recFill = 0;       // dev-only raw PCM capture (see onMessage "record")
    this.inRms = 0;                          // smoothed RMS of the RAW input (see unattributedRms)
    this.path = new Float32Array(2 * PATH_PER_MSG);   // interleaved x,y since the last message
    this.fp = new Float64Array(2);           // scratch for figurePhasor()
    this.pathN = 0;
    this.lastCents = null;
    this.scores = null;                      // last detection block's per-candidate scores
    this.detCents = 0;                       // ...and the winning comb's offset, in cents
    this.odd3 = null;                        // per candidate: did its winning comb see harmonic 3?
    this.env2 = 0;                           // amplitude follower on the 2*f0 leg (see `starved`)
    this.starved = false;                    // f0 below the gate while 2*f0 is not: mic rolloff
    this.unattrRun = 0;                      // consecutive messages of loud-but-unattributed input
    this.gateShut = true;                    // is the locked string currently producing nothing?
    this.settle = 0;                         // samples left before the demodulator output is usable
    this.settleSamples = 0;
    this.lastX = 0; this.lastY = 0; this.lastTh = 0; this.lastR = 0;

    this.sizeDetector();
    this.retune();

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (!m) return;
    if (m.type === "targets") {
      const same = this.targets.length === m.freqs.length && this.targets.every((f, i) => f === m.freqs[i]);
      this.targets = m.freqs.slice();
      this.ratios = m.ratios ? m.ratios.slice() : [];
      this.sizeDetector();
      if (!same) {
        this.locked = -1; this.cand = -1; this.candRuns = 0;
        if (this.pinned >= this.targets.length) this.pinned = -1;
        if (this.pinned >= 0) this.locked = this.pinned;
        this.resetEstimator();
      }
      else this.retune();     // same strings (e.g. a redundant post) — do not disturb the lock
    } else if (m.type === "config") {
      Object.assign(this.cfg, m.values || {});
      const lsqN = Math.max(4, Math.round(this.cfg.lsqSec * this.unwrapPerSec));
      if (lsqN !== this.s1.n) { this.s1 = new Slope(lsqN); this.s2 = new Slope(lsqN); }
      this.sizeDetector();
      this.retune();
    } else if (m.type === "record") {
      // Dev-only. Capture RAW mono PCM, not captured I/Q, so that the bandwidth and the
      // demodulator itself stay variable under replay — which is the entire point of replaying.
      // Accumulated here and posted ONCE (transferred, not copied): posting per-quantum would be
      // ~375 messages a second to say nothing.
      if (m.on) { this.rec = new Float32Array(Math.round(m.seconds * this.rate)); this.recFill = 0; }
      else this.flushRecording();
    } else if (m.type === "pin") {
      // Pin the tuner to ONE string and stop detecting. Tuning by fifths means bowing the
      // NEIGHBOUR as a reference for much of the session, and detection follows whatever is
      // loudest — measured on a real "tune the G string" take, the app read D4 for 18 of its 27
      // seconds because the G fundamental arrives ~20 dB down. Automatic detection is right for
      // "what am I playing"; it is wrong for "I am adjusting THIS peg", and only the player knows
      // which of those is happening.
      const i = (m.index === null || m.index === undefined) ? -1 : m.index | 0;
      this.pinned = i >= 0 && i < this.targets.length ? i : -1;
      if (this.pinned >= 0 && this.pinned !== this.locked) {
        this.locked = this.pinned; this.cand = -1; this.candRuns = 0;
        this.resetEstimator();
      }
    } else if (m.type === "reset") {
      this.locked = -1; this.cand = -1; this.candRuns = 0; this.resetEstimator();
    }
  }

  flushRecording() {
    if (!this.rec) return;
    const buf = this.rec.subarray(0, this.recFill).slice();   // trim, then hand off the copy
    this.rec = null; this.recFill = 0;
    this.port.postMessage({ rec: buf, sampleRate: this.rate }, [buf.buffer]);
  }

  // Detection block length, from the closest candidate pair (see DETECT_BINS_PER_GAP).
  sizeDetector() {
    let gap = Infinity;
    for (let i = 1; i < this.targets.length; i++) gap = Math.min(gap, this.targets[i] - this.targets[i - 1]);
    let N = DETECT_N_MIN;
    if (isFinite(gap) && gap > 0) {
      const need = this.rate / (gap / DETECT_BINS_PER_GAP);
      while (N < need && N < DETECT_N_MAX) N *= 2;
    }
    if (!this.detBuf || this.detBuf.length !== N) { this.detBuf = new Float32Array(N); this.detFill = 0; }
    this.detN = N;
    this.buildProbes();
  }

  // Precompute each candidate's COMBS: one Goertzel coefficient per harmonic per candidate offset,
  // the offsets spanning +-DETECT_BAND_CENTS. Scoring takes the best offset (see runDetection), so
  // a candidate is only credited for partials that line up at ONE consistent mistuning — which is
  // the whole content of "these partials belong to that string" (see DETECT_HARMONICS above).
  //
  // Offsets are spaced in CENTS, not Hz, because a mistuned string shifts every harmonic by the
  // same cents. The step is set by the TOP harmonic — half a bin at kMax*f0, so the highest, most
  // sharply-tuned member of the comb can never fall between two offsets and be missed. Every lower
  // harmonic is then oversampled, which costs nothing.
  buildProbes() {
    const res = this.rate / this.detN;              // Hz per bin
    const coefOf = (f) => 2 * Math.cos((2 * Math.PI * f) / this.rate);
    const K = Math.max(1, Math.round(this.cfg.detHarmonics));
    const nyq = this.rate * 0.5;
    const hi = Math.pow(2, DETECT_BAND_CENTS / 1200);

    this.probes = this.targets.map((f0) => {
      // Drop harmonics whose band would run past Nyquist — aliased bins score noise.
      let kMax = 0;
      while (kMax < K && f0 * (kMax + 1) * hi < nyq) kMax++;
      if (kMax < 1) kMax = 1;

      const stepC = 1200 * Math.log2(1 + (0.5 * res) / (f0 * kMax));
      const M = Math.max(3, Math.min(DETECT_OFFSETS_MAX, Math.ceil((2 * DETECT_BAND_CENTS) / stepC) + 1));
      const combs = new Array(M), cents = new Float64Array(M);
      for (let m = 0; m < M; m++) {
        const dc = -DETECT_BAND_CENTS + (2 * DETECT_BAND_CENTS * m) / (M - 1);
        const r = Math.pow(2, dc / 1200);
        const c = new Float64Array(kMax);
        for (let k = 1; k <= kMax; k++) c[k - 1] = coefOf(f0 * k * r);
        cents[m] = dc;
        combs[m] = c;
      }
      return { kMax: kMax, combs: combs, cents: cents };
    });
  }

  // Point the demodulators at the locked string. bw2 = 2*bw1 so the 2*f0 demodulator has the same
  // capture range measured IN CENTS as the f0 one — its phasor moves twice as fast, so an equal
  // bandwidth in Hz would be half the range in cents.
  retune() {
    if (this.locked < 0) return;
    const f0 = this.targets[this.locked];
    const bw = Math.min(this.cfg.bwMax, Math.max(this.cfg.bwMin, this.cfg.bwCoef * f0));
    this.d1.tune(f0, bw);
    this.d2.tune(2 * f0, 2 * bw);
    // How long the cascade needs after a reset before its output means anything. A zeroed 4-pole
    // filter struck by a strong OUT-OF-BAND tone rings: the transient briefly clears the noise gate
    // even though the signal is nowhere near f0, and the estimator dutifully reports whatever the
    // ringing looks like. Caught as +50 cents on a tone 250 cents off — the exact class of small,
    // plausible, wrong number that ADDENDUM section 3 exists to prevent. SETTLE_TC time constants
    // of the per-section cutoff, in samples.
    this.settleSamples = Math.ceil((SETTLE_TC * this.rate) / (2 * Math.PI * CASCADE_SCALE * bw));
  }

  // Called on an ACTUAL string change only — never on a redundant detection result. Resetting the
  // demodulator phase mid-note visibly jerks the figure, which is what the detection hysteresis
  // exists to prevent.
  resetEstimator() {
    this.d1.reset(); this.d2.reset();
    this.u1.reset(); this.u2.reset();
    this.s1.reset(); this.s2.reset();
    this.blend = 0; this.useH2 = false;
    this.env2 = 0; this.starved = false;
    // Drop the octave guard's evidence along with everything else. It is scored PER CANDIDATE, so a
    // freshly re-locked string would otherwise inherit the previous block's verdict for its index —
    // and the starved path, which is the one thing allowed to open the gate on 2*f0 alone, would run
    // on a stale "yes". Measured as three messages of a wrong number leaking out per re-lock.
    // Absent evidence the answer must be no; the next detection block re-establishes it in ~40 ms.
    this.odd3 = null;
    this.retune();                  // recomputes settleSamples for the new string...
    this.settle = this.settleSamples || 0;   // ...and this is the countdown itself
  }

  // Score every candidate over one detection block and apply the 6 dB x 3 blocks hysteresis.
  // The 2*f0 term is the cello-C2 mitigation: phone mics roll off steeply below ~100 Hz, so C2's
  // fundamental is often WEAKER than its second partial, and scoring on the fundamental alone
  // loses the string entirely.
  runDetection() {
    const n = this.detN, buf = this.detBuf;
    let best = -1, bestScore = 0, lockedScore = 0;
    const scores = new Array(this.targets.length);
    const offsets = new Array(this.targets.length);
    const odd3 = new Array(this.targets.length);
    // The "is this harmonic there at all" floor, measured from THIS block (see DETECT_FLOOR_REL).
    // For a sinusoid of amplitude A, goertzelPower is (n*A/2)^2 and sum(x^2) is n*A^2/2, so
    // (n/2)*energy puts the two in the same units.
    let energy = 0;
    for (let i = 0; i < n; i++) energy += buf[i] * buf[i];
    const floor = DETECT_FLOOR_REL * (n / 2) * energy;
    const logFloor = Math.log(floor > 0 ? floor : Number.MIN_VALUE);
    for (let c = 0; c < this.targets.length; c++) {
      const pr = this.probes[c];
      let score = 0, offset = 0, odd = false;
      for (let m = 0; m < pr.combs.length; m++) {    // best SHARED offset, not best per harmonic
        const comb = pr.combs[m];
        // Geometric mean of the comb's harmonic powers, penalised per absent harmonic, so a
        // missing partial cannot be papered over by a loud one (see DETECT_FLOOR_REL above).
        let ls = 0, pen = 1, any = false, odd3 = false;
        for (let k = 0; k < pr.kMax; k++) {
          const pw = goertzelPower(buf, n, comb[k]);
          if (pw > floor) { ls += Math.log(pw); any = true; if (k === 2) odd3 = true; }
          else { ls += logFloor; pen *= k === 0 ? DETECT_MISS_PEN * DETECT_MISS_PEN_F0 : DETECT_MISS_PEN; }
        }
        const s = any ? Math.exp(ls / pr.kMax) * pen : 0;
        if (s > score) { score = s; offset = pr.cents[m]; odd = odd3; }
      }
      scores[c] = score;
      offsets[c] = offset;
      // Did the winning comb see the THIRD harmonic? That is the octave guard for the starved path
      // in emit(). A tone that is really at 2*f0 puts energy only on EVEN multiples of f0, so it can
      // fake k=2 and k=4 but never k=3; a real string whose fundamental the microphone lost still
      // has its odd partials. Without this, a bare 570 Hz tone read as "D4, 46 cents flat" — the
      // same octave degeneracy the harmonic sum exists to avoid, re-entered through the back door.
      odd3[c] = odd;
      if (score > bestScore) { bestScore = score; best = c; }
      if (c === this.locked) lockedScore = score;
    }
    // Keep the raw scores for diagnostics: the ?dev=1 panel shows them in dB relative to the
    // winner, which is the only way to SEE why a string that is plainly sounding does not take the
    // lock. Nothing in the render or the estimate reads them.
    this.scores = scores;
    this.detCents = best >= 0 ? offsets[best] : 0;   // the winning comb's offset: a coarse pitch read
    this.odd3 = odd3;
    if (best < 0) return;

    // Pinned: the scores above are still worth having (the dev panel shows them, and they are how
    // you see that the string you pinned is not actually the loudest thing in the room), but the
    // lock is the player's choice and nothing here may override it.
    if (this.pinned >= 0) { this.locked = this.pinned; this.cand = -1; this.candRuns = 0; return; }


    if (this.locked < 0) {                      // nothing locked yet: take the winner immediately
      this.locked = best; this.cand = -1; this.candRuns = 0;
      this.resetEstimator();
      return;
    }
    if (best === this.locked) { this.cand = -1; this.candRuns = 0; return; }

    // A challenger must beat the incumbent by hystDb across hystBlocks CONSECUTIVE blocks. Without
    // this the lock flaps on every bow change, and each flap resets the demodulator phase.
    //
    // ...unless the incumbent's GATE IS SHUT, in which case it is producing no reading at all and
    // there is nothing for the hysteresis to protect. Dropping the dB threshold (but not the
    // consecutive-block count, which is what stops noise flapping during silence) makes the escape
    // level-independent: the unattributedRms path in emit() only fires when the room is LOUD, and a
    // quiet microphone — an iPhone reported a whole loopback sweep under the gate — leaves a wrong
    // lock stuck with no way out. A lock that hears nothing has no claim on being kept.
    const beatsBy = 10 * Math.log10((bestScore + 1e-30) / (lockedScore + 1e-30));
    if (beatsBy >= (this.gateShut ? 0 : this.cfg.hystDb)) {
      if (best === this.cand) this.candRuns++;
      else { this.cand = best; this.candRuns = 1; }
      if (this.candRuns >= this.cfg.hystBlocks) {
        this.locked = best; this.cand = -1; this.candRuns = 0;
        this.resetEstimator();                  // an ACTUAL string change: this is the one time
      }
    } else { this.cand = -1; this.candRuns = 0; }
  }

  process(inputs) {
    const input = inputs[0];
    const block = input && input[0];
    const len = block ? block.length : QUANTUM;

    // Raw input level, independent of any lock. Used only to tell "silence" apart from "loud, but
    // not attributable to any string" — a string more than DETECT_BAND_CENTS off falls outside
    // every band, so whatever we lock hears nothing and the gate closes. Reporting "listening"
    // while the player is bowing hard is the wrong answer.
    if (block) {
      let sum = 0;
      for (let n = 0; n < len; n++) sum += block[n] * block[n];
      this.inRms += 0.2 * (Math.sqrt(sum / len) - this.inRms);
    } else {
      this.inRms *= 0.8;
    }

    if (this.rec && block) {
      const room = Math.min(len, this.rec.length - this.recFill);
      if (room > 0) { this.rec.set(block.subarray(0, room), this.recFill); this.recFill += room; }
      if (this.recFill >= this.rec.length) this.flushRecording();     // full: hand it over
    }

    // Detection runs on the raw signal, in detN-sized blocks assembled across quanta.
    if (block && this.targets.length) {
      for (let n = 0; n < len; n++) {
        this.detBuf[this.detFill++] = block[n];
        if (this.detFill >= this.detN) { this.runDetection(); this.detFill = 0; }
      }
    }

    // --- demodulate and estimate, in UNWRAP_STRIDE chunks (see UNWRAP_STRIDE) ---
    // The amplitude follower and the plotted geometry are updated in here too, once per chunk, so
    // the path carries every phasor sample rather than one in sixteen (see PATH_PER_MSG).
    const cfg = this.cfg;
    const aAtt = 1 - Math.exp(-1 / Math.max(1, cfg.attackSec * this.unwrapPerSec));
    const aRel = 1 - Math.exp(-1 / Math.max(1, cfg.releaseSec * this.unwrapPerSec));
    // Drop the 2*f0 overlay at large error: past ~25 cents that phasor undersamples and only adds
    // visual noise. Uses the previous message's cents, which moves far slower than a quantum.
    const ow = (this.lastCents !== null && Math.abs(this.lastCents) <= cfg.overlayGateCents)
      ? cfg.overlayWeight : 0;

    let th1 = 0;
    for (let off = 0; off < len; off += UNWRAP_STRIDE) {
      const n = Math.min(UNWRAP_STRIDE, len - off);
      if (this.locked >= 0 && block) {
        this.d1.run(block, off, n);
        this.d2.run(block, off, n);
        th1 = Math.atan2(this.d1.Q, this.d1.I);
        this.s1.push(this.u1.push(th1));
        this.s2.push(this.u2.push(Math.atan2(this.d2.Q, this.d2.I)));

        const a1 = this.d1.mag, a2 = this.d2.mag;
        this.env += (a1 > this.env ? aAtt : aRel) * (a1 - this.env);
        this.env2 += (a2 > this.env2 ? aAtt : aRel) * (a2 - this.env2);
        // Normalizing by the follower (not the instantaneous amplitude) is what holds the radius
        // steady across bow pressure. The guard is load-bearing: env is exactly 0 on the first
        // chunks and during silence, and an unguarded divide puts NaN into the render.
        const env = this.env > 1e-9 ? this.env : 1e-9;
        if (this.pathN < PATH_PER_MSG && cfg.figureMode === 0) {
          const p = this.figurePhasor(env);
          this.path[this.pathN * 2] = p[0] + (this.starved ? 0 : (ow * this.d2.I) / env);
          this.path[this.pathN * 2 + 1] = p[1] + (this.starved ? 0 : (ow * this.d2.Q) / env);
          this.pathN++;
        }
      } else {
        this.s1.push(this.u1.push(0));      // keep the windows fed so nothing goes stale or NaN
        this.s2.push(this.u2.push(0));
      }
    }

    if (this.settle > 0) this.settle -= len;

    const amp1 = this.locked >= 0 ? this.d1.mag : 0;
    const amp2 = this.locked >= 0 ? this.d2.mag : 0;

    this.quantum++;
    if (this.quantum % MSG_EVERY === 0) this.emit(amp1, amp2, th1);
    return true;
  }

  // The figure's FUNDAMENTAL phasor, normalized so a healthy note sits near unit radius.
  //
  // Normally that is just the f0 demodulator. But a phone microphone can roll the fundamental of a
  // violin G below the gate while its second partial is still loud, and then d1 carries only noise
  // — the figure becomes a noise circle and the reading becomes meaningless. In that case take the
  // phase from the 2*f0 unwrapper and HALVE it: same rotation rate, same direction, same one turn
  // per beat Hz, but measured on the partial that actually arrived. The absolute offset differs by
  // a constant, which is unobservable (the whole figure has a rotation knob).
  figurePhasor(env) {
    if (this.starved) {
      const h = 0.5 * this.u2.acc;
      const e2 = this.env2 > 1e-9 ? this.env2 : 1e-9;
      const r = Math.min(2, this.d2.mag / e2);
      this.fp[0] = r * Math.cos(h); this.fp[1] = r * Math.sin(h);
    } else {
      this.fp[0] = this.d1.I / env; this.fp[1] = this.d1.Q / env;
    }
    return this.fp;
  }

  // A true two-tone Lissajous, built parametrically from the SAME measured phasor the readout uses.
  //
  //   x = cos(q*u)                       the reference, synthesized
  //   y = the microphone, narrowband at the string's target, reconstructed from I/Q as
  //       I*cos(p*u) - Q*sin(p*u), which is the demodulator's own identity run backwards
  //
  // In mode 1, p:q is 1:1 and the figure is the classic tuning ellipse: still when in tune,
  // cycling line -> circle -> line once per beat Hz, direction giving the sign of the error. In
  // mode 2, p:q is the string's ratio to the reference A (violin D is 2:3, E is 3:2, G is 4:9), so
  // each string gets its own closed shape and the error shows as PRECESSION of that shape.
  //
  // Ratios are exact only in pure temperament, which is what makes them integers at all. In equal
  // temperament a perfectly tuned string still precesses very slowly — 2 cents a fifth. That is
  // honest, not a bug, and it is one of the few places the difference is visible rather than
  // asserted.
  buildLissajous(ow) {
    const mode = this.cfg.figureMode | 0;
    const r = mode === 2 && this.ratios[this.locked] ? this.ratios[this.locked] : [1, 1];
    const p = r[0], q = r[1];
    const N = Math.max(FIG_N_MIN, Math.min(FIG_N_MAX, FIG_N_PER_CYCLE * Math.max(p, q)));
    const out = new Float32Array(2 * N);
    const env = this.env > 1e-9 ? this.env : 1e-9;
    const f = this.figurePhasor(env);
    const i1 = f[0], q1 = f[1];
    // The overlay's size RELATIVE to the fundamental is the timbre, so both legs must share one
    // normalizer. When the fundamental is synthesized there is no common normalizer and no
    // fundamental to overlay onto, so the overlay is simply dropped.
    const w = this.starved ? 0 : ow;
    const i2 = this.d2.I / env, q2 = this.d2.Q / env;
    for (let j = 0; j < N; j++) {
      const u = (2 * Math.PI * j) / N;
      const pu = p * u;
      let y = i1 * Math.cos(pu) - q1 * Math.sin(pu);
      if (w) y += w * (i2 * Math.cos(2 * pu) - q2 * Math.sin(2 * pu));
      out[2 * j] = Math.cos(q * u);
      out[2 * j + 1] = y;
    }
    return out;
  }

  emit(amp1, amp2, th1) {
    const cfg = this.cfg;
    // Gate on EITHER leg. A phone microphone rolls off hard below ~200 Hz and a violin body barely
    // radiates 196 Hz, so a plainly-sounding open G can arrive with its fundamental under the gate
    // and its second partial 20 dB above it. Gating on amp1 alone reported that as silence.
    // ...but only when detection actually saw this string's THIRD harmonic. See runDetection: an
    // odd partial is the one thing a tone sitting at 2*f0 cannot supply, and without that guard the
    // 2*f0 leg happily reports an octave-wrong reading with full confidence.
    this.starved = amp1 < cfg.gateAmp && amp2 >= cfg.gateAmp
      && !!(this.odd3 && this.locked >= 0 && this.odd3[this.locked]);
    // The 2*f0 leg may only open the gate through `starved`, i.e. only once the octave guard has
    // passed. Letting amp2 open it on its own is the same octave hole in a new place: a violin
    // playing D5 puts energy on D4's k=2 and k=4 and nothing on its k=3, so the D4 demodulator sees
    // a huge 2*f0 and a silent f0 — and the app reported "D4, about in tune" for a note an OCTAVE
    // above it. Caught on a real recording; the narrower gate this replaced had been hiding it.
    // Settling counts as gated: no reading, and the figure freezes rather than drawing the ringing.
    const gated = this.settle > 0 || (amp1 < cfg.gateAmp && !this.starved);
    this.gateShut = gated;                   // read by runDetection (see the hysteresis bypass)
    let st, cents = null;

    // Loud input we cannot attribute reads as "out of range" whether or not something is locked.
    // Tying that to the lock was wrong twice over: it made a 250-cent-flat string read as silence
    // once the lock had been dropped, and it made the unlock below flip the display to "listening"
    // — the exact misreading ADDENDUM section 3 exists to prevent. What the player needs to know is
    // "I hear you and I cannot place it", and that does not depend on our lock bookkeeping.
    const unattributed = this.inRms > cfg.unattributedRms;
    if (this.locked < 0) st = unattributed ? 3 : 2;    // searching
    else if (gated) st = unattributed ? 3 : 0;         // nothing to hear, vs loud but unexplained
    else st = 1;

    // A lock that hears NOTHING while the room is loud is a lock on the wrong string, and the
    // hysteresis that protects a working lock is exactly wrong here: it holds the deaf one. A real
    // violin sweep of G-D-A-E reported "G3, out of range" for all four notes because of this, for
    // 32 of 35 seconds. Detection margins are now 9 dB rather than 1.6, but margins are a property
    // of the instrument and the room, so this stays as the escape hatch that does not depend on
    // them: drop the lock and let the next block take the winner outright, with no threshold to beat.
    if (this.locked >= 0 && this.pinned < 0 && gated && unattributed) {
      if (++this.unattrRun >= Math.max(1, Math.round(cfg.unlockSec * (this.quantaPerSec / MSG_EVERY)))) {
        this.locked = -1; this.cand = -1; this.candRuns = 0; this.unattrRun = 0;
        this.resetEstimator();
      }
    } else this.unattrRun = 0;

    let f0 = this.locked >= 0 ? this.targets[this.locked] : 0;

    if (st === 1) {
      // Two independent estimates of the same quantity. The 2*f0 phasor rotates at twice the error
      // rate, so it reaches a given precision in half the time — but only inside +-25 cents and only
      // when that partial is actually present. ADDENDUM section 4.
      const df1 = (this.s1.slope() * this.unwrapPerSec) / (2 * Math.PI);
      const df2 = (this.s2.slope() * this.unwrapPerSec) / (2 * Math.PI) / 2;   // halve: it moves 2x

      const centsOf = (df) => 1200 * Math.log2(Math.max(1e-9, 1 + df / f0));
      const c1 = centsOf(df1);

      if (this.starved) {
        // The fundamental is under the gate and the second partial is not, so c1 is noise and
        // there is nothing on the f0 side worth blending in. Switch outright rather than
        // crossfading through garbage — the 2*f0 estimate is not an approximation here, it is the
        // only measurement that exists.
        this.useH2 = true;
        this.blend = 1;
      } else {
        const relOk = amp2 > cfg.h2MinRel * amp1;
        if (this.useH2) this.useH2 = relOk && Math.abs(c1) < cfg.h2ExitCents;
        else this.useH2 = relOk && Math.abs(c1) < cfg.h2EnterCents;

        // Crossfade rather than switch. Both estimate the same number, so they agree closely — but
        // a hard swap would still show as a step in the readout, which is exactly what a tuner must
        // never do. ADDENDUM section 4: "never let the displayed number jump when it crosses over."
        const target = this.useH2 ? 1 : 0;
        const step = 1 / Math.max(1, cfg.h2BlendSec * (this.quantaPerSec / MSG_EVERY));
        this.blend += Math.max(-step, Math.min(step, target - this.blend));
      }

      const df = (1 - this.blend) * df1 + this.blend * df2;
      cents = centsOf(df);

      // Past this the Goertzel bandwidth means we may be locked to the WRONG string, so a number
      // is unjustifiable whether or not the unwrap survived. Report nothing rather than a plausible
      // lie. ADDENDUM section 3.
      if (!isFinite(cents) || Math.abs(cents) > cfg.outOfRangeCents) { st = 3; cents = null; }
    }

    // --- render-ready geometry -------------------------------------------------
    // Mode 0's path was filled per UNWRAP_STRIDE chunk in process() and is handed over as a TRAIL
    // the renderer appends to. Modes 1 and 2 are a closed CURVE rebuilt from the current phasor,
    // which the renderer replaces wholesale — hence `fk`, so app.js never has to guess which it got.
    const mode = cfg.figureMode | 0;
    const env = this.env > 1e-9 ? this.env : 1e-9;
    if (this.pathN > 0) {
      this.lastX = this.path[(this.pathN - 1) * 2];
      this.lastY = this.path[(this.pathN - 1) * 2 + 1];
    }
    if (st === 1 || st === 3) {
      this.lastTh = th1;
      this.lastR = Math.min(4, (this.starved ? amp2 / (this.env2 > 1e-9 ? this.env2 : 1e-9) : amp1 / env));
    }

    // st 0 and 2 send an EMPTY path: the main thread freezes and dims the figure, holding exactly
    // what it last drew. A stale figure that still looks in tune is the main way this class of app
    // lies, so a freeze must not quietly keep extending the curve.
    const live = st === 1 || st === 3;
    const ow = (this.lastCents !== null && Math.abs(this.lastCents) <= cfg.overlayGateCents)
      ? cfg.overlayWeight : 0;
    const path = !live ? new Float32Array(0)
      : mode === 0 ? this.path.slice(0, this.pathN * 2)
      : this.buildLissajous(ow);
    this.pathN = 0;
    this.lastCents = cents;

    this.port.postMessage({
      s: this.locked,
      c: cents === null ? null : Math.round(cents * 1000) / 1000,
      th: this.lastTh,
      r: this.lastR,
      st,
      x: this.lastX,
      y: this.lastY,
      p: path,
      fk: mode === 0 ? 0 : 1,          // 0 = trail segment (append), 1 = closed curve (replace)
      // Absolute levels, for diagnostics only — nothing in the render uses them. `a` is the
      // demodulated amplitude at the locked string (i.e. how much energy is actually in that
      // string's band) and `n` is the raw input RMS. The ratio between them across the four
      // strings IS the microphone's frequency response, which is what makes a weak fundamental
      // visible instead of merely suspected.
      a: amp1,
      n: this.inRms,
      // Per-candidate detection scores from the last block, in dB relative to the winner. Purely
      // diagnostic. A string that is sounding but not locked shows up here as a candidate sitting a
      // couple of dB below the incumbent — which is the failure that looks like "nothing happens".
      sc: this.scores ? this.scores.map((v) => 10 * Math.log10((v + 1e-30) / (Math.max.apply(null, this.scores) + 1e-30))) : null,
    }, [path.buffer]);
  }
}

registerProcessor("tuner", TunerProcessor);
