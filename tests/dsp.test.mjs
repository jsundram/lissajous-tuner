// The headless DSP suite. Every assertion runs against tuner-worklet.js itself, loaded under `vm`
// (see harness.mjs) — the file that ships, not a port of it.
//
// Cases 1-7 are the plan's; 8-9 are the ADDENDUM's (section 3, the aliasing case that used to
// report a plausible wrong number); 10 is the cello C2/G2 pair, which the plan's fixed 1024-sample
// detection block could not have separated at all.
//
// Everything runs at 44100, 48000 and 16000 — iOS gives 48k on newer devices but can drop the mic
// path to 16k under some constraint combinations, and NOTHING here may depend on the rate.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeTuner, loadStrings, tone, silence, concat, centsToRatio, centsToHz,
} from "./harness.mjs";

const S = loadStrings();
const RATES = [44100, 48000, 16000];
const SECONDS = 3;

const violin = (t = "pure") => S.targets("violin", 440, t);
const cello = (t = "pure") => S.targets("cello", 440, t);

// Median of the settled tail — robust to a stray sample at a block boundary.
function settledCents(T) {
  const cs = T.settled().map((m) => m.c).filter((c) => c !== null && Number.isFinite(c));
  assert.ok(cs.length > 0, "no cents values in the settled window");
  cs.sort((a, b) => a - b);
  return cs[Math.floor(cs.length / 2)];
}
const settledMode = (T, key) => {
  const v = T.settled().map((m) => m[key]);
  return v.sort((a, b) =>
    v.filter((x) => x === a).length - v.filter((x) => x === b).length).pop();
};

// Nothing may ever emit a non-finite number: the render divides by the amplitude follower and
// atan2/unwrap run on silence. A NaN here paints a blank canvas with no error.
function assertNoNaN(T) {
  for (const m of T.messages) {
    for (const k of ["th", "r", "x", "y"]) {
      assert.ok(Number.isFinite(m[k]), `non-finite ${k}: ${m[k]}`);
    }
    assert.ok(m.c === null || Number.isFinite(m.c), `non-finite c: ${m.c}`);
    assert.ok(Number.isInteger(m.st) && m.st >= 0 && m.st <= 3, `bad st: ${m.st}`);
  }
}

for (const rate of RATES) {
  // --- 1: exact tone at target -------------------------------------------------
  test(`[${rate}] exact tone at A440 -> |cents| < 0.05 and a static phasor`, () => {
    const t = violin();
    const T = makeTuner({ rate, targets: t }).feed(tone(t[2], SECONDS, rate));
    assert.equal(T.last().s, 2, "should lock A4");
    assert.equal(T.last().st, 1, "should be locked, not gated/searching");
    assert.ok(Math.abs(settledCents(T)) < 0.05, `cents=${settledCents(T)}`);

    // "Phasor angle static" — with zero error the angle must not walk. Measured as the spread
    // about the circular mean, so a reading that straddles +-pi does not read as huge.
    const th = T.settled().map((m) => m.th);
    const mx = th.reduce((s, a) => s + Math.cos(a), 0) / th.length;
    const my = th.reduce((s, a) => s + Math.sin(a), 0) / th.length;
    const mean = Math.atan2(my, mx);
    const spread = Math.max(...th.map((a) => Math.abs(Math.atan2(Math.sin(a - mean), Math.cos(a - mean)))));
    assert.ok(spread < 0.05, `phasor drifted ${spread.toFixed(4)} rad`);
    assertNoNaN(T);
  });

  // --- 2: THE anchor. 1 revolution per second at A440 is exactly 3.93 cents ------
  test(`[${rate}] A440 +3.93 cents -> df = 1.00 +- 0.01 Hz (one revolution/second)`, () => {
    const t = violin();
    const T = makeTuner({ rate, targets: t }).feed(tone(t[2] * centsToRatio(3.93), SECONDS, rate));
    const df = centsToHz(settledCents(T), t[2]);
    assert.ok(Math.abs(df - 1.0) < 0.01, `df=${df.toFixed(4)} Hz`);
    assertNoNaN(T);
  });

  // --- 3: cello C2, the hardest string ------------------------------------------
  test(`[${rate}] cello C2 -20 cents -> correct sign, within 0.5 cents`, () => {
    const t = cello();
    const T = makeTuner({ rate, targets: t })
      .feed(tone(t[0] * centsToRatio(-20), SECONDS, rate, { partials: 4 }));
    assert.equal(T.last().s, 0, "should lock C2");
    const c = settledCents(T);
    assert.ok(c < 0, `sign wrong: ${c}`);
    assert.ok(Math.abs(c - -20) < 0.5, `cents=${c}`);
    assertNoNaN(T);
  });

  // --- 4: detection against a full partial series --------------------------------
  test(`[${rate}] D4 with 6 partials -> locks D, not G, not A`, () => {
    const t = violin();
    const T = makeTuner({ rate, targets: t })
      .feed(tone(t[1], SECONDS, rate, { partials: 6 }));
    assert.equal(settledMode(T, "s"), 1, "must lock D4");
    assert.ok(Math.abs(settledCents(T)) < 0.5, `cents=${settledCents(T)}`);
    assertNoNaN(T);
  });

  // --- 5: detection bandwidth on a badly flat string -----------------------------
  test(`[${rate}] D4 at -80 cents -> still locks D`, () => {
    const t = violin();
    const T = makeTuner({ rate, targets: t })
      .feed(tone(t[1] * centsToRatio(-80), SECONDS, rate, { partials: 4 }));
    assert.equal(settledMode(T, "s"), 1, "must still lock D4");
    assert.ok(Math.abs(settledCents(T) - -80) < 0.5, `cents=${settledCents(T)}`);
    assertNoNaN(T);
  });

  // --- 6: silence ----------------------------------------------------------------
  test(`[${rate}] silence -> gate closes, no NaN`, () => {
    const t = violin();
    // From cold: nothing to lock onto, so this is "searching", not "gated".
    const cold = makeTuner({ rate, targets: t }).feed(silence(1.0, rate));
    assert.equal(cold.last().st, 2, "cold silence should report searching");
    assertNoNaN(cold);

    // The real case: a note that stops. The lock survives, the GATE closes, and the figure
    // freezes — a stale figure that still looks in tune is the main way this app could lie.
    const T = makeTuner({ rate, targets: t })
      .feed(concat(tone(t[2], 1.5, rate), silence(1.5, rate)));
    assert.equal(T.last().st, 0, "gate should be closed after the note stops");
    assertNoNaN(T);
  });

  // --- 8 (ADDENDUM section 3): the case that used to alias -------------------------
  // 100 cents at E5 is 39 Hz. Unwrapping at the 94 Hz MESSAGE rate caps out at 47 Hz, so this
  // reading used to fold over and report a small, plausible, wrong number. Unwrapping at the
  // QUANTUM rate raises the ceiling to ~187 Hz.
  test(`[${rate}] E5 at -80 cents -> correct sign, within 0.5 cents (no aliasing)`, () => {
    const t = violin();
    const T = makeTuner({ rate, targets: t })
      .feed(tone(t[3] * centsToRatio(-80), SECONDS, rate, { partials: 3 }));
    assert.equal(settledMode(T, "s"), 3, "must lock E5");
    const c = settledCents(T);
    assert.ok(c < 0, `sign wrong: ${c}`);
    assert.ok(Math.abs(c - -80) < 0.5, `cents=${c}`);
    assertNoNaN(T);
  });

  // --- 9 (ADDENDUM section 3): refuse to report past +-120 cents --------------------
  test(`[${rate}] E5 at -250 cents -> st 3 and NO cents value`, () => {
    const t = violin();
    const T = makeTuner({ rate, targets: t })
      .feed(tone(t[3] * centsToRatio(-250), SECONDS, rate, { partials: 3 }));
    const tail = T.settled();
    assert.ok(tail.every((m) => m.st === 3), `states: ${[...new Set(tail.map((m) => m.st))]}`);
    assert.ok(tail.every((m) => m.c === null), "must not report a cents value out of range");
    assertNoNaN(T);
  });

  // --- 10: the pair the plan's fixed 1024-sample block could not separate -----------
  // Cello C2 (65.2) and G2 (97.8) are 32.6 Hz apart; a 1024-sample block at 48k is ~47 Hz wide.
  // The detector sizes its block from the closest candidate pair, which is what makes this pass.
  test(`[${rate}] cello G2 -> locks G2, not C2 (32.6 Hz apart)`, () => {
    const t = cello();
    const T = makeTuner({ rate, targets: t }).feed(tone(t[1], SECONDS, rate, { partials: 4 }));
    assert.equal(settledMode(T, "s"), 1, "must lock G2, not C2");
    assertNoNaN(T);
  });

  // --- 11: the bug a real violin found ----------------------------------------------
  // Reported from an actual open G: the label read E5. Cause was scoring each candidate by the
  // peak in a +-300 cent band around its FUNDAMENTAL — E5's band was 555-785 Hz, which contains
  // G3's 3rd and 4th partials (587 and 782). On a real violin the G fundamental is weak, so those
  // partials won. Fixed by narrowing the band to +-150 (catches neither) and scoring the harmonic
  // SERIES so a rolled-off fundamental no longer loses the string.
  //
  // Fundamental at a tenth of the second partial — a deliberately brutal version of mic rolloff.
  test(`[${rate}] violin open G with a rolled-off fundamental -> locks G3, NOT E5`, () => {
    const t = violin();
    const T = makeTuner({ rate, targets: t })
      .feed(tone(t[0], SECONDS, rate, { amps: [0.03, 0.30, 0.20, 0.14, 0.10, 0.07, 0.05, 0.04] }));
    const s = settledMode(T, "s");
    assert.equal(s, 0, `locked ${s === 3 ? "E5 — the original bug" : "index " + s}, must be G3`);
    assert.ok(Math.abs(settledCents(T)) < 1.0, `cents=${settledCents(T)}`);
    assertNoNaN(T);
  });

  // The same failure mode one string over, and the plan's stated hardest case: phone mics roll off
  // steeply below ~100 Hz, so cello C2's fundamental can be weaker than its second partial.
  test(`[${rate}] cello C2 with a rolled-off fundamental -> locks C2, not G2`, () => {
    const t = cello();
    const T = makeTuner({ rate, targets: t })
      .feed(tone(t[0], SECONDS, rate, { amps: [0.02, 0.30, 0.22, 0.15, 0.11, 0.08] }));
    assert.equal(settledMode(T, "s"), 0, "must lock C2");
    assertNoNaN(T);
  });

  test(`[${rate}] cello C2 -> locks C2, not G2`, () => {
    const t = cello();
    const T = makeTuner({ rate, targets: t }).feed(tone(t[0], SECONDS, rate, { partials: 4 }));
    assert.equal(settledMode(T, "s"), 0, "must lock C2, not G2");
    assertNoNaN(T);
  });

  // --- 12: the bug a real violin found the second time -------------------------------
  // Every case above bows ONE string into a fresh tuner, which is the one thing a player never
  // does. A 35-second video of a real G-D-A-E sweep read "G3 / out of range" for 32 of them: the
  // lock took G3 and never moved. Detection margins between fifth-related strings were 1.6-5.7 dB
  // against a 6 dB hysteresis, so nine of the twelve transitions were unreachable BY CONSTRUCTION
  // and no single-string test could see it.
  //
  // The fix is three-part and this case is what holds all three honest: score each candidate as a
  // geometric mean over a shared-offset comb (margins to 9 dB), drop the hysteresis to 3 dB, and
  // unlock outright when a locked string hears nothing while the room is loud.
  for (const [name, inst, profiles] of [
    ["violin", violin, [
      [0.02, 0.30, 0.22, 0.16, 0.11, 0.08, 0.05, 0.04],   // dull G: fundamental 23 dB down
      [0.15, 0.30, 0.20, 0.13, 0.09, 0.06],
      [0.22, 0.26, 0.16, 0.10, 0.07],
      [0.15, 0.30, 0.25, 0.18, 0.12],                     // bright E: 2nd partial over the 1st
    ]],
    ["cello", cello, [
      [0.02, 0.30, 0.22, 0.15, 0.11, 0.08, 0.06, 0.05],
      [0.06, 0.30, 0.20, 0.14, 0.10, 0.07],
      [0.20, 0.26, 0.18, 0.12, 0.08],
      [0.26, 0.24, 0.16, 0.10, 0.07],
    ]],
  ]) {
    for (const gapSec of [0, 0.3]) {
      test(`[${rate}] ${name} sweep across all four strings${gapSec ? "" : ", no gaps"} -> each is found`, () => {
        const t = inst();
        const NOTE = 1.6;
        const parts = [];
        for (let i = 0; i < 4; i++) {
          parts.push(tone(t[i] * centsToRatio(-10), NOTE, rate, { amps: profiles[i].map((a) => a * 0.3) }));
          if (gapSec) parts.push(silence(gapSec, rate));
        }
        const T = makeTuner({ rate, targets: t }).feed(concat(...parts));
        const perSec = rate / 128 / 4;                    // messages per second
        const seg = (NOTE + gapSec) * perSec;
        for (let i = 0; i < 4; i++) {
          // Judge the tail of each note: the first 40% is allowed to still be switching.
          const win = T.messages.slice(Math.round(i * seg + 0.4 * NOTE * perSec),
                                       Math.round(i * seg + 0.98 * NOTE * perSec));
          const votes = {};
          let locked = 0;
          for (const m of win) { votes[m.s] = (votes[m.s] || 0) + 1; if (m.st === 1) locked++; }
          const heard = Number(Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0]);
          assert.equal(heard, i, `bowing string ${i} but locked ${heard} — the sticky-lock bug`);
          assert.ok(locked / win.length > 0.9,
            `string ${i} reported a reading only ${Math.round((100 * locked) / win.length)}% of the note`);
        }
        assertNoNaN(T);
      });
    }
  }
}

// --- the figure modes -------------------------------------------------------------
// Not a measurement, but the ratio plumbing crosses three files (strings.js computes it, tuner.js
// posts it, the worklet draws from it) and a browser check caught it silently falling back to 1:1
// because the constructor overwrote processorOptions a few lines after reading them. Lobe counts
// are the cheapest thing that could have caught that: an x/y zero-crossing count IS q and p.
for (const rate of [48000, 16000]) {
  test(`[${rate}] figureMode 2 draws each string's true ratio to the reference A`, () => {
    const t = violin(), r = S.ratios("violin");
    for (let i = 0; i < 4; i++) {
      const T = makeTuner({ rate, targets: t, ratios: r, config: { figureMode: 2 } })
        .feed(tone(t[i] * centsToRatio(3.93), 2.0, rate, { partials: 3 }));
      const m = T.last();
      assert.equal(m.s, i, `should lock string ${i}`);
      assert.equal(m.fk, 1, "a Lissajous mode must post a CLOSED CURVE, not a trail segment");
      const n = m.p.length / 2;
      let xz = 0, yz = 0;
      for (let k = 1; k < n; k++) {
        if (Math.sign(m.p[2 * k]) !== Math.sign(m.p[2 * (k - 1)])) xz++;
        if (Math.sign(m.p[2 * k + 1]) !== Math.sign(m.p[2 * (k - 1) + 1])) yz++;
      }
      assert.equal(xz, 2 * r[i][1], `${["G3", "D4", "A4", "E5"][i]}: x should cross zero 2q times`);
      assert.equal(yz, 2 * r[i][0], `${["G3", "D4", "A4", "E5"][i]}: y should cross zero 2p times`);
    }
  });

  test(`[${rate}] figureMode 0 still posts an appendable trail`, () => {
    const t = violin();
    const T = makeTuner({ rate, targets: t }).feed(tone(t[2], 2.0, rate, { partials: 3 }));
    assert.equal(T.last().fk, 0, "the phasor mode must stay a trail");
  });
}

// --- 13: the octave, found on a real recording ---------------------------------------
// A violinist playing D5 (a stopped note on the A string) while the tuner was locked to the open D
// got "D4, about in tune" — for a note an OCTAVE above it. D5 puts energy on D4's k=2 and k=4 and
// NOTHING on its k=3, which is exactly the signature the odd-harmonic guard exists to catch; the
// guard was there, but it only protected the ESTIMATE, while the widened gate (either demodulator
// leg may open it, so a mic-rolled-off G still reads) let 2*f0 alone open the gate underneath it.
//
// The second half of this is the demodulator's start-up transient: a zeroed 4-pole cascade struck
// by a strong out-of-band tone rings hard enough to clear the gate for a few messages, which leaked
// +50 cents on a tone 250 cents off. Hence SETTLE_TC. Both halves are asserted here.
for (const rate of [44100, 48000, 16000]) {
  test(`[${rate}] a note an octave above an open string is never reported as that string`, () => {
    const t = violin();
    // 2*D4 with its own harmonics: lands on D4's even members only, never its k=3.
    const T = makeTuner({ rate, targets: t })
      .feed(tone(2 * t[1], SECONDS, rate, { amps: [0.30, 0.15, 0.10, 0.06] }));
    for (const m of T.settled()) {
      assert.ok(!(m.s === 1 && m.st === 1 && m.c !== null && Math.abs(m.c) < 60),
        `reported D4 at ${m.c} cents for a tone an octave above it`);
    }
    assertNoNaN(T);
  });
}

// --- pinning ------------------------------------------------------------------------
// Tuning by fifths means bowing the NEIGHBOUR for much of the session. Measured on a real "tune the
// G string" recording, the app read D4 for 18 of 27 seconds — correctly, because the D really was
// 20 dB louder than the G. Detection answers "what am I playing"; the player pinning a string
// answers "I am adjusting THIS peg", and nothing in the DSP may override the second with the first.
for (const rate of [48000, 16000]) {
  test(`[${rate}] a pinned string survives a louder neighbour`, () => {
    const t = violin();
    const T = makeTuner({ rate, targets: t });
    T.send({ type: "pin", index: 0 });                  // pin G3
    // ...then play a D4 that is 20 dB louder than anything on the G string.
    T.feed(tone(t[1], SECONDS, rate, { amps: [0.30, 0.22, 0.15, 0.10] }));
    assert.equal(settledMode(T, "s"), 0, "a pinned G3 must not be dragged onto a loud D4");
    assertNoNaN(T);
  });

  test(`[${rate}] unpinning restores automatic detection`, () => {
    const t = violin();
    const T = makeTuner({ rate, targets: t });
    T.send({ type: "pin", index: 0 });
    T.feed(tone(t[1], 1.5, rate, { amps: [0.30, 0.22, 0.15, 0.10] }));
    assert.equal(T.last().s, 0, "still pinned");
    T.send({ type: "pin", index: -1 });
    T.feed(tone(t[1], 2.0, rate, { amps: [0.30, 0.22, 0.15, 0.10] }));
    assert.equal(T.last().s, 1, "after unpinning it must find the D4 that is actually sounding");
    assertNoNaN(T);
  });
}

// --- temperament ------------------------------------------------------------------
// Not a DSP case, but the number it produces is the app's whole premise: pure and equal fifths
// differ by 1.955 cents each, so violin G3 sits 3.91 cents flat of equal and viola/cello C 5.87.
test("pure vs equal fifths diverge by the documented amounts", () => {
  const p = violin("pure"), e = violin("equal");
  const cents = (a, b) => 1200 * Math.log2(a / b);
  assert.ok(Math.abs(cents(p[0], e[0]) - -3.91) < 0.01, `violin G3: ${cents(p[0], e[0])}`);
  const pc = cello("pure"), ec = cello("equal");
  assert.ok(Math.abs(cents(pc[0], ec[0]) - -5.87) < 0.01, `cello C2: ${cents(pc[0], ec[0])}`);
});

// A tuned string parks the figure; error walks it around at df Hz. This is the number on the box.
test("the 3.93-cent anchor is exactly one revolution per second at A440", () => {
  assert.ok(Math.abs(centsToHz(3.93, 440) - 1.0) < 0.001);
});

// --- self-test mode acceptance (?test=1&cents=3.93) ---------------------------------
// The arithmetic above is necessary but not sufficient: what has to be true is that the FIGURE
// turns once per second. That is the phasor angle `th` the render actually consumes, so measure
// revolutions out of the posted messages rather than trusting the cents number to imply them.
// The synthetic source here mirrors testSource() in tuner.js: 3 partials at 0, -6 and -12 dB.
for (const rate of RATES) {
  test(`[${rate}] self-test at +3.93 cents -> the figure turns 1.000 rev/s`, () => {
    const t = violin();
    const secs = 4;
    const T = makeTuner({ rate, targets: t });
    // 0 / -6 / -12 dB is amplitude 1 / 0.5 / 0.25, which is what `decay: 1` does NOT give —
    // build it explicitly so this matches the shipped test source.
    const f = t[2] * centsToRatio(3.93);
    const n = Math.floor(secs * rate);
    const sig = new Float32Array(n);
    [0.3, 0.15, 0.075].forEach((a, k) => {
      const w = (2 * Math.PI * f * (k + 1)) / rate;
      for (let i = 0; i < n; i++) sig[i] += a * Math.sin(w * i);
    });
    T.feed(sig);

    // Unwrap the posted angle over the settled tail and convert to revolutions per second.
    const tail = T.settled(0.5);
    let acc = 0, prev = tail[0].th;
    for (const m of tail.slice(1)) {
      let d = m.th - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      acc += d; prev = m.th;
    }
    const msgRate = rate / 128 / 4;                       // messages per second
    const revs = Math.abs(acc / (2 * Math.PI)) / ((tail.length - 1) / msgRate);
    assert.ok(Math.abs(revs - 1.0) < 0.02, `figure turned ${revs.toFixed(4)} rev/s, want 1.000`);
    assert.ok(Math.abs(settledCents(T) - 3.93) < 0.05, `cents=${settledCents(T)}`);
  });
}
