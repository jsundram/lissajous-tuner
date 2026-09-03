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
// gives a flat capture wider than the +-100 cents the plan asks for.
//
// A band cannot collide with a NEIGHBOUR'S BAND: consecutive strings are a fifth apart = 702
// cents, so any half-width below 351 keeps them disjoint. But it can absolutely collide with a
// neighbour's PARTIALS, and at +-300 cents it did: E5's band was 555-785 Hz, which contains G3's
// 3rd and 4th partials (587 and 782 Hz). On a real violin the G string's fundamental is weak — the
// body barely radiates 196 Hz and phone mics roll off there — so those partials beat it and an
// open G read as E5. +-150 still covers +-100 and catches none of them.
const DETECT_BAND_CENTS = 150;
const DETECT_PROBE_MAX = 64;       // per harmonic bank; a ceiling on the per-block cost

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
    this.rec = null; this.recFill = 0;       // dev-only raw PCM capture (see onMessage "record")
    this.inRms = 0;                          // smoothed RMS of the RAW input (see unattributedRms)
    this.path = new Float32Array(2 * PATH_PER_MSG);   // interleaved x,y since the last message
    this.pathN = 0;
    this.lastCents = null;
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
    } else if (m.type === "record") {
      // Dev-only. Capture RAW mono PCM, not captured I/Q, so that the bandwidth and the
      // demodulator itself stay variable under replay — which is the entire point of replaying.
      // Accumulated here and posted ONCE (transferred, not copied): posting per-quantum would be
      // ~375 messages a second to say nothing.
      if (m.on) { this.rec = new Float32Array(Math.round(m.seconds * this.rate)); this.recFill = 0; }
      else this.flushRecording();
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

  // Precompute each candidate's probe banks: one band of Goertzel coefficients per harmonic,
  // spanning +-DETECT_BAND_CENTS and spaced at half a bin so the band's response has no dips
  // between probes. Spacing derives from the bin width rather than being fixed in cents, so a high
  // harmonic (whose band spans many bins) gets more probes than a low one.
  //
  // A mistuned string shifts EVERY harmonic by the same ratio, so the band is the same width in
  // cents at every k — which is what lets the series still line up on a flat string.
  buildProbes() {
    const res = this.rate / this.detN;              // Hz per bin
    const lo = Math.pow(2, -DETECT_BAND_CENTS / 1200), hi = Math.pow(2, DETECT_BAND_CENTS / 1200);
    const coefOf = (f) => 2 * Math.cos((2 * Math.PI * f) / this.rate);
    const K = Math.max(1, Math.round(this.cfg.detHarmonics));
    const nyq = this.rate * 0.5;

    this.probes = this.targets.map((f0) => {
      const banks = [];
      for (let k = 1; k <= K; k++) {
        // Drop a harmonic whose band would run past Nyquist — aliased bins score noise.
        if (f0 * k * hi >= nyq) break;
        const span = f0 * k * (hi - lo);
        const n = Math.max(3, Math.min(DETECT_PROBE_MAX, Math.ceil(span / (0.5 * res)) + 1));
        const bank = new Float64Array(n);
        for (let j = 0; j < n; j++) {
          bank[j] = coefOf(f0 * k * (lo + ((hi - lo) * j) / (n - 1)));
        }
        banks.push({ w: 1 / k, bank: bank });        // 1/k: a partial matters less the higher it is
      }
      return banks;
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
    let best = -1, bestScore = 0, lockedScore = 0;
    for (let c = 0; c < this.targets.length; c++) {
      const banks = this.probes[c];
      let score = 0;
      for (let h = 0; h < banks.length; h++) {
        const bank = banks[h].bank;
        let peak = 0;                                // best power anywhere in THIS harmonic's band
        for (let j = 0; j < bank.length; j++) {
          const pw = goertzelPower(buf, n, bank[j]);
          if (pw > peak) peak = pw;
        }
        score += banks[h].w * peak;                  // sum the series, weighted 1/k
      }
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

        const a1 = this.d1.mag;
        this.env += (a1 > this.env ? aAtt : aRel) * (a1 - this.env);
        // Normalizing by the follower (not the instantaneous amplitude) is what holds the radius
        // steady across bow pressure. The guard is load-bearing: env is exactly 0 on the first
        // chunks and during silence, and an unguarded divide puts NaN into the render.
        const env = this.env > 1e-9 ? this.env : 1e-9;
        if (this.pathN < PATH_PER_MSG) {
          this.path[this.pathN * 2] = (this.d1.I + ow * this.d2.I) / env;
          this.path[this.pathN * 2 + 1] = (this.d1.Q + ow * this.d2.Q) / env;
          this.pathN++;
        }
      } else {
        this.s1.push(this.u1.push(0));      // keep the windows fed so nothing goes stale or NaN
        this.s2.push(this.u2.push(0));
      }
    }

    const amp1 = this.locked >= 0 ? this.d1.mag : 0;
    const amp2 = this.locked >= 0 ? this.d2.mag : 0;

    this.quantum++;
    if (this.quantum % MSG_EVERY === 0) this.emit(amp1, amp2, th1);
    return true;
  }

  emit(amp1, amp2, th1) {
    const cfg = this.cfg;
    const gated = amp1 < cfg.gateAmp;
    let st, cents = null;

    if (this.locked < 0) st = 2;                       // searching
    else if (gated) {
      // Gate closed. Two very different reasons, and they must not look the same to the player:
      // nothing to hear, versus something loud that no string's detection band explains.
      st = this.inRms > cfg.unattributedRms ? 3 : 0;
    } else st = 1;

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
    // The path was filled per UNWRAP_STRIDE chunk in process(); here it is just handed over.
    const env = this.env > 1e-9 ? this.env : 1e-9;
    if (this.pathN > 0) {
      this.lastX = this.path[(this.pathN - 1) * 2];
      this.lastY = this.path[(this.pathN - 1) * 2 + 1];
    }
    if (st === 1 || st === 3) {
      this.lastTh = th1;
      this.lastR = Math.min(4, amp1 / env);
    }

    // st 0 and 2 send an EMPTY path: the main thread freezes and dims the figure, holding exactly
    // what it last drew. A stale figure that still looks in tune is the main way this class of app
    // lies, so a freeze must not quietly keep extending the curve.
    const path = (st === 1 || st === 3)
      ? this.path.slice(0, this.pathN * 2)
      : new Float32Array(0);
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
    }, [path.buffer]);
  }
}

registerProcessor("tuner", TunerProcessor);
