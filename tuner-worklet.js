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
const LPF_SECTIONS = 4;     // ADDENDUM section 2 — a single pole is not enough (see CASCADE_SCALE)

// Cascading N identical one-poles NARROWS the composite response: for N=4 the -3 dB point sits at
// 0.435x the per-section cutoff. Scale the per-section cutoff up by 1/0.435 to preserve the capture
// range `bw` actually asks for. Skip this and the capture range silently halves, which reads as a
// twitchy lock on a flat string and sends you chasing the bandwidth knob instead.
const CASCADE_SCALE = 2.3;

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
// gives a flat capture far wider than +-100 cents. The bands cannot collide, which is the whole
// reason this is safe: consecutive strings are a fifth apart = 702 cents, so any half-width below
// 351 cents keeps every candidate's band disjoint from its neighbours'.
const DETECT_BAND_CENTS = 300;
const DETECT_PROBE_MAX = 48;       // per candidate; a ceiling on the per-block cost

// Defaults. The main thread owns the authoritative copy of this table (tuner.js PARAMS, which is
// what the ?dev=1 panel is generated from) and posts it as a `config` message at startup; these are
// the fallbacks that make the worklet runnable on its own, which is how tests/ drives it.
const DEFAULTS = {
  // --- measurement: changes what the app REPORTS ---
  bwCoef: 0.06,             // capture bandwidth as a fraction of f0
  bwMin: 6, bwMax: 45,      // Hz, clamps on the above
  lsqSec: 0.5,              // least-squares slope window
  hystDb: 6, hystBlocks: 3, // a new string must beat the locked one by this much, this many times
  gateAmp: 0.0012,          // demodulated magnitude below which we refuse to report (noise floor)
  // Weight of a 2*f0 probe in the DETECTION score. DEFAULT 0, and raise it only with a real cello
  // in hand: consecutive strings are fifths, so G2 = 1.5*C2 means 2*G2 = 3*C2 EXACTLY — an octave
  // probe on one string lands precisely on the third partial of the string below, which is the
  // octave confusion the whole four-candidate design exists to avoid. It is here because phone mics
  // roll off steeply below ~100 Hz and C2's fundamental can be weaker than its second partial; if
  // that turns out to break C2 detection on a real instrument, this is the knob, and the lock will
  // need watching. Tracking (as opposed to detection) already has an octave path that is safe: the
  // 2*f0 phasor blend below.
  detH2Weight: 0,
  outOfRangeCents: 120,     // beyond this: st 3, and NO cents value (ADDENDUM section 3)
  h2EnterCents: 20,         // use the 2*f0 phasor as the primary estimate inside this...
  h2ExitCents: 25,          // ...and fall back outside this (hysteresis, so it cannot chatter)
  h2MinRel: 0.15,           // ...and only if the 2*f0 partial is at least this strong vs f0
  h2BlendSec: 0.35,         // crossfade time between the two estimates, so the number never jumps
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
    this.cand = -1; this.candRuns = 0;       // hysteresis state
    this.env = 0;                            // amplitude follower
    this.blend = 0;                          // 0 = f0 estimate, 1 = 2*f0 estimate
    this.useH2 = false;
    this.quantum = 0;
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
      this.sizeDetector();
      if (!same) { this.locked = -1; this.cand = -1; this.candRuns = 0; this.resetEstimator(); }
      else this.retune();     // same strings (e.g. a redundant post) — do not disturb the lock
    } else if (m.type === "config") {
      Object.assign(this.cfg, m.values || {});
      const lsqN = Math.max(4, Math.round(this.cfg.lsqSec * this.unwrapPerSec));
      if (lsqN !== this.s1.n) { this.s1 = new Slope(lsqN); this.s2 = new Slope(lsqN); }
      this.sizeDetector();
      this.retune();
    } else if (m.type === "reset") {
      this.locked = -1; this.cand = -1; this.candRuns = 0; this.resetEstimator();
    }
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

  // Precompute each candidate's probe bank: Goertzel coefficients across +-DETECT_BAND_CENTS,
  // spaced at half a bin so the band's response has no dips between probes. Spacing is derived
  // from the bin width rather than fixed in cents, so a high string (whose band spans many bins)
  // gets more probes than a low one (whose band is barely wider than a single bin).
  buildProbes() {
    const res = this.rate / this.detN;              // Hz per bin
    const lo = Math.pow(2, -DETECT_BAND_CENTS / 1200), hi = Math.pow(2, DETECT_BAND_CENTS / 1200);
    const coefOf = (f) => 2 * Math.cos((2 * Math.PI * f) / this.rate);
    this.probes = this.targets.map((f0) => {
      const span = f0 * (hi - lo);
      const n = Math.max(3, Math.min(DETECT_PROBE_MAX, Math.ceil(span / (0.5 * res)) + 1));
      const bank = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const frac = n === 1 ? 0.5 : k / (n - 1);
        bank[k] = coefOf(f0 * (lo + (hi - lo) * frac));
      }
      return bank;
    });
    // The optional 2*f0 probe (see detH2Weight) is a single bin, not a band: it exists only to
    // notice a fundamental the mic rolled off, and widening it would overlap the neighbour above.
    this.probesH2 = this.targets.map((f0) => coefOf(Math.min(2 * f0, this.rate * 0.49)));
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
  }

  // Called on an ACTUAL string change only — never on a redundant detection result. Resetting the
  // demodulator phase mid-note visibly jerks the figure, which is what the detection hysteresis
  // exists to prevent.
  resetEstimator() {
    this.d1.reset(); this.d2.reset();
    this.u1.reset(); this.u2.reset();
    this.s1.reset(); this.s2.reset();
    this.blend = 0; this.useH2 = false;
    this.retune();
  }

  // Score every candidate over one detection block and apply the 6 dB x 3 blocks hysteresis.
  // The 2*f0 term is the cello-C2 mitigation: phone mics roll off steeply below ~100 Hz, so C2's
  // fundamental is often WEAKER than its second partial, and scoring on the fundamental alone
  // loses the string entirely.
  runDetection() {
    const n = this.detN, buf = this.detBuf;
    const w2 = this.cfg.detH2Weight;
    let best = -1, bestScore = 0, lockedScore = 0;
    for (let c = 0; c < this.targets.length; c++) {
      const bank = this.probes[c];
      let peak = 0;                                  // best power anywhere in this string's band
      for (let k = 0; k < bank.length; k++) {
        const pw = goertzelPower(buf, n, bank[k]);
        if (pw > peak) peak = pw;
      }
      const score = w2 ? peak + w2 * goertzelPower(buf, n, this.probesH2[c]) : peak;
      if (score > bestScore) { bestScore = score; best = c; }
      if (c === this.locked) lockedScore = score;
    }
    if (best < 0) return;

    if (this.locked < 0) {                      // nothing locked yet: take the winner immediately
      this.locked = best; this.cand = -1; this.candRuns = 0;
      this.resetEstimator();
      return;
    }
    if (best === this.locked) { this.cand = -1; this.candRuns = 0; return; }

    // A challenger must beat the incumbent by hystDb across hystBlocks CONSECUTIVE blocks. Without
    // this the lock flaps on every bow change, and each flap resets the demodulator phase.
    const beatsBy = 10 * Math.log10((bestScore + 1e-30) / (lockedScore + 1e-30));
    if (beatsBy >= this.cfg.hystDb) {
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

    // Detection runs on the raw signal, in detN-sized blocks assembled across quanta.
    if (block && this.targets.length) {
      for (let n = 0; n < len; n++) {
        this.detBuf[this.detFill++] = block[n];
        if (this.detFill >= this.detN) { this.runDetection(); this.detFill = 0; }
      }
    }

    // --- demodulate and estimate, in UNWRAP_STRIDE chunks (see UNWRAP_STRIDE) ---
    let th1 = 0;
    for (let off = 0; off < len; off += UNWRAP_STRIDE) {
      const n = Math.min(UNWRAP_STRIDE, len - off);
      if (this.locked >= 0 && block) {
        this.d1.run(block, off, n);
        this.d2.run(block, off, n);
        th1 = Math.atan2(this.d1.Q, this.d1.I);
        this.s1.push(this.u1.push(th1));
        this.s2.push(this.u2.push(Math.atan2(this.d2.Q, this.d2.I)));
      } else {
        this.s1.push(this.u1.push(0));      // keep the windows fed so nothing goes stale or NaN
        this.s2.push(this.u2.push(0));
      }
    }

    const amp1 = this.locked >= 0 ? this.d1.mag : 0;
    const amp2 = this.locked >= 0 ? this.d2.mag : 0;

    // Amplitude follower: fast attack, slow release, so the figure holds a stable radius as the
    // note decays instead of collapsing toward the centre and reading as "in tune".
    const aAtt = 1 - Math.exp(-1 / Math.max(1, this.cfg.attackSec * this.quantaPerSec));
    const aRel = 1 - Math.exp(-1 / Math.max(1, this.cfg.releaseSec * this.quantaPerSec));
    this.env += (amp1 > this.env ? aAtt : aRel) * (amp1 - this.env);

    this.quantum++;
    if (this.quantum % MSG_EVERY === 0) this.emit(amp1, amp2, th1);
    return true;
  }

  emit(amp1, amp2, th1) {
    const cfg = this.cfg;
    const gated = amp1 < cfg.gateAmp;
    let st, cents = null;

    if (this.locked < 0) st = 2;                       // searching
    else if (gated) st = 0;                            // below the noise floor
    else st = 1;

    let f0 = this.locked >= 0 ? this.targets[this.locked] : 0;

    if (st === 1) {
      // Two independent estimates of the same quantity. The 2*f0 phasor rotates at twice the error
      // rate, so it reaches a given precision in half the time — but only inside +-25 cents and only
      // when that partial is actually present. ADDENDUM section 4.
      const df1 = (this.s1.slope() * this.unwrapPerSec) / (2 * Math.PI);
      const df2 = (this.s2.slope() * this.unwrapPerSec) / (2 * Math.PI) / 2;   // halve: it moves 2x

      const centsOf = (df) => 1200 * Math.log2(Math.max(1e-9, 1 + df / f0));
      const c1 = centsOf(df1);

      const relOk = amp2 > cfg.h2MinRel * amp1;
      if (this.useH2) this.useH2 = relOk && Math.abs(c1) < cfg.h2ExitCents;
      else this.useH2 = relOk && Math.abs(c1) < cfg.h2EnterCents;

      // Crossfade rather than switch. Both estimate the same number, so they agree closely — but a
      // hard swap would still show as a step in the readout, which is exactly what a tuner must
      // never do. ADDENDUM section 4: "never let the displayed number jump when it crosses over."
      const target = this.useH2 ? 1 : 0;
      const step = 1 / Math.max(1, cfg.h2BlendSec * (this.quantaPerSec / MSG_EVERY));
      this.blend += Math.max(-step, Math.min(step, target - this.blend));

      const df = (1 - this.blend) * df1 + this.blend * df2;
      cents = centsOf(df);

      // Past this the Goertzel bandwidth means we may be locked to the WRONG string, so a number
      // is unjustifiable whether or not the unwrap survived. Report nothing rather than a plausible
      // lie. ADDENDUM section 3.
      if (!isFinite(cents) || Math.abs(cents) > cfg.outOfRangeCents) { st = 3; cents = null; }
    }

    // --- render-ready geometry -------------------------------------------------
    // Normalizing by the follower (not by the instantaneous amplitude) is what keeps the radius
    // stable across bow pressure. The guard is load-bearing: env is exactly 0 on the first quanta
    // and during silence, and an unguarded divide puts NaN into the render.
    const env = this.env > 1e-9 ? this.env : 1e-9;
    if (st === 1 || st === 3) {
      // Drop the 2*f0 overlay when the error is large: past ~25 cents that phasor undersamples at
      // the message rate and only adds visual noise.
      const w = (cents !== null && Math.abs(cents) <= cfg.overlayGateCents) ? cfg.overlayWeight : 0;
      this.lastX = (this.d1.I + w * this.d2.I) / env;
      this.lastY = (this.d1.Q + w * this.d2.Q) / env;
      this.lastTh = th1;
      this.lastR = Math.min(4, amp1 / env);
    }
    // st 0 and 2 deliberately hold the previous geometry: the main thread freezes and dims the
    // figure. A stale figure that still looks in tune is the main way this class of app lies.

    this.port.postMessage({
      s: this.locked,
      c: cents === null ? null : Math.round(cents * 1000) / 1000,
      th: this.lastTh,
      r: this.lastR,
      st,
      x: this.lastX,
      y: this.lastY,
    });
  }
}

registerProcessor("tuner", TunerProcessor);
