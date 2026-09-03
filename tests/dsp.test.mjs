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

  test(`[${rate}] cello C2 -> locks C2, not G2`, () => {
    const t = cello();
    const T = makeTuner({ rate, targets: t }).feed(tone(t[0], SECONDS, rate, { partials: 4 }));
    assert.equal(settledMode(T, "s"), 0, "must lock C2, not G2");
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
