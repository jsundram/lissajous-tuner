// strings.js — target frequencies, derived rather than tabulated.
//
// Loaded as a plain script in the browser (sets window.Strings) and evaluated under `vm` by
// tests/, so there is exactly one copy of this arithmetic. Main-thread only: the worklet is handed
// finished frequencies and never computes them.
//
// String players tune PURE fifths (exactly 3/2), not equal-tempered ones (2^(7/12)). The two differ
// by 1.955 cents per fifth, so the outer strings diverge audibly: violin G3 is 3.91 cents flat of
// equal, viola/cello C is 5.87 cents flat. Pure is the default because it is both what actually
// happens in a quartet and the more interesting half of the app.
(function (root) {
  "use strict";

  const PURE = 3 / 2;
  const EQUAL = Math.pow(2, 7 / 12);

  // Each instrument names its strings low-to-high and says which one is the anchor and what the
  // anchor is worth relative to the reference A. Everything else is built by fifths from there.
  const INSTRUMENTS = {
    violin: { label: "Violin", names: ["G3", "D4", "A4", "E5"], anchor: 2, anchorRatio: 1 },
    viola:  { label: "Viola",  names: ["C3", "G3", "D4", "A4"], anchor: 3, anchorRatio: 1 },
    cello:  { label: "Cello",  names: ["C2", "G2", "D3", "A3"], anchor: 3, anchorRatio: 0.5 },
  };

  // refA in Hz (default 440), temperament "pure" | "equal".
  function targets(instrument, refA, temperament) {
    const spec = INSTRUMENTS[instrument];
    if (!spec) throw new Error("unknown instrument: " + instrument);
    const r = temperament === "equal" ? EQUAL : PURE;
    const f = new Array(spec.names.length);
    f[spec.anchor] = refA * spec.anchorRatio;
    for (let i = spec.anchor - 1; i >= 0; i--) f[i] = f[i + 1] / r;   // down by fifths
    for (let i = spec.anchor + 1; i < f.length; i++) f[i] = f[i - 1] * r;   // and up
    return f;
  }

  root.Strings = { INSTRUMENTS, targets, PURE, EQUAL };
})(typeof globalThis !== "undefined" ? globalThis : self);
