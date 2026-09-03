# Addendum to PLAN.md — apply before writing more DSP

Four corrections. Item 1 is a structural boundary that gets expensive to change once the message
protocol and tests are built against the old shape, so do it first. Items 2 and 3 are defects in the
plan, not preferences. Item 4 retracts a claim the plan made.

If code already exists against the old shape, refactor it rather than layering on top — none of
this is additive.

---

## 1. All estimation moves into the worklet

PLAN.md has the worklet posting raw I/Q and the main thread doing unwrap, least-squares and gating.
Wrong boundary. Move detection, unwrap, slope estimation and gating **into the worklet**. The main
thread renders and nothing else.

Post every 4th quantum (≈94 Hz), one object:

```js
{s: 2, c: -3.87, th: 1.92, r: 0.61, st: 1, x: 0.42, y: -0.31}
```

- `s` — locked string index within the current instrument, 0–3
- `c` — cents error, signed
- `th` — phasor angle, radians, for anything angular in the render
- `r` — normalized radius after the amplitude follower
- `x`, `y` — composite plot coordinates (see item 4)
- `st` — `0` gated (below noise floor) · `1` locked · `2` searching · `3` out of range

The amplitude follower and the normalization live in the worklet too, so `r`, `x`, `y` arrive
render-ready. The main thread must not need `sampleRate` or any DSP constant.

This is the item that's a one-way door: the test harness asserts against these messages, so
building it against raw I/Q means rewriting both later.

## 2. The lowpass must be a cascade, not a single pole

A single one-pole gives 6 dB/octave. At G3 with an effective bandwidth near 12 Hz that's only about
24 dB of rejection on the string's own second partial — and on a bowed G string that partial is
often louder than the fundamental. The residual wobbles the phasor and reads as jitter that looks
exactly like a bandwidth problem, so it sends you chasing the wrong knob in the dev panel.

Use **4 cascaded one-pole sections** with the same coefficient. Four extra multiplies per sample,
72–96 dB of rejection.

Critical detail: cascading N identical one-poles narrows the composite response. For N = 4 the
−3 dB point sits at 0.435 × the per-section cutoff, so scale the per-section cutoff up by 2.3 to
preserve the capture range the plan specifies:

```js
bw = clamp(0.06 * f0, 6, 45)        // target capture range, unchanged
fc = 2.3 * bw                       // per-section cutoff, N = 4
a  = 1 - Math.exp(-2 * Math.PI * fc / sampleRate)
```

Skip the scaling and the capture range silently halves and lock becomes twitchy on a flat string.

Filter order is now a **correctness** parameter in the dev panel, not an aesthetic one.

## 3. Unwrap at quantum rate, and refuse to report beyond ±120 cents

Phase unwrapping fails when the phasor moves more than π between samples. Unwrapping at the 94 Hz
message rate caps you at a 47 Hz error — but 100 cents at E5 is 39 Hz, so a string a whole tone flat
aliases and reports a small, plausible, wrong number. Silent and worse than reporting nothing.

Item 1 fixes this structurally: unwrap once per quantum (375 Hz at 48 kHz), which raises the ceiling
to ~187 Hz and puts it beyond any real error. Run the least-squares slope on that 375 Hz series
over the same 0.5 s window (≈188 samples) with running sums.

Add an explicit guard anyway: if `|c| > 120`, emit `st: 3` and **do not report a cents value**. Past
100 cents the Goertzel detection bandwidth means you may be locked to the wrong string, so a number
there is unjustifiable regardless of whether the unwrap survived.

Two test cases to add:

- E5 at −80 cents → correct sign and magnitude within 0.5 cents (this is the case that used to alias)
- E5 at −250 cents → `st: 3`, no cents value

## 4. Retraction: 2:1 does not produce evolving rosettes

PLAN.md claims overlaying phasors at a 2:1 rate ratio yields harmonograph rosettes whose symmetry
encodes error. That's wrong. Any exact integer rate ratio traces a **fixed closed curve** — here a
limaçon — traversed once per `1/Δf`. Its shape is set by the partial's relative amplitude and phase,
which is a property of your string, bow and instrument, not of your tuning.

Keep the visual: shape reads as timbre, motion reads as error, which is clear and honest. Drop any
UI copy or comment suggesting the figure's shape means something about pitch. Keep the `0.4` mix
weight as an aesthetic knob.

The resolution benefit was real but only if you use it properly — the plan didn't. Read the **2·f0
phasor's own angle** as the primary estimate and halve the resulting `Δf`; that genuinely halves the
time to a given precision. Use it when the 2·f0 amplitude is adequate and `|c| < 25`, otherwise fall
back to the f0 estimate. Hysteresis on that switch, and never let the displayed number jump when it
crosses over.

One observation, not a feature to engineer: real strings are slightly inharmonic from bending
stiffness, so the second partial sits a few cents above exactly 2·f0. The limaçon will therefore
precess very slowly on its own. That's physics showing up in the render, and it's worth not
"fixing."
