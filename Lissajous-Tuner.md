# Lissajous Tuner — implementation plan

A phase-coherent string tuner for violin/viola/cello. Renders tuning error as a rotating
harmonograph figure rather than a needle. Zero-build static PWA on top of `pwa-starter`.

## Preconditions

Run `pwa-starter`'s (https://github.com/jsundram/pwa-starter) CLAUDE.md → *New project* flow **first** (name, description, URL, icons).
This plan assumes that has completed and the app boots. Then build the tuner into the existing
flat file layout — no bundler, no `src/`, no npm runtime deps.

## Why not an FFT

`AnalyserNode.getFloatFrequencyData` returns magnitudes and discards phase. Phase *is* the signal:
a strobe tuner's accuracy comes from watching a phase difference drift over seconds, which is
unbounded in resolution, where FFT bin resolution is capped by window length. Do not use
`AnalyserNode` anywhere in the signal path.

The whole app is quadrature demodulation: multiply the mic signal by a locally generated
sine/cosine pair at the target frequency, lowpass both, and the resulting vector's **angle** is the
phase offset and its **rotation rate** is the frequency error in Hz. Because reference and signal
are generated in the same `AudioContext` from the same `sampleRate`, there is no clock drift
between them — which is otherwise the accuracy ceiling.

## Signal chain

```
getUserMedia → MediaStreamSource → TunerWorklet → GainNode(0) → destination
```

The zero-gain `GainNode` to `destination` is **required**, not decorative: an `AudioWorkletNode`
whose output is unconnected is not pulled by the graph on Safari, and `process()` silently stops
being called. Gain must be 0 to avoid feedback through the speaker.

## Stage 1 — string detection (coarse)

The instrument is chosen by the user (segmented control), so detection only picks among that
instrument's four strings. This avoids general pitch detection entirely and sidesteps octave
errors: an instrument's four open strings are a fifth apart, and no string's partial series lands
on another string's fundamental.

Per 1024-sample block, compute a Goertzel magnitude at each of the four candidate fundamentals.
A 1024-sample block at 48 kHz is ~47 Hz wide, comfortably wider than the ±100 cents a badly out
of tune string can sit at (100 cents at G3 is 11.6 Hz), so a flat string is still detected.

Switch the locked string only when a new candidate beats the current one by 6 dB across 3
consecutive blocks. Without this hysteresis the lock flaps during bow changes and resets the
demodulator phase, which visibly jerks the figure. **Only reset demodulator phase on an actual
string change.**

## Stage 2 — quadrature demodulation (fine)

```js
w = 2 * Math.PI * f0 / sampleRate            // reference phase increment
a = 1 - Math.exp(-2 * Math.PI * fc / sampleRate)   // one-pole LPF coefficient
```

Per sample: advance `p` by `w`; then

```
i += a * (x * Math.cos(p) - i)
q += a * (-x * Math.sin(p) - q)
```

Keep `p` wrapped to `[0, 2π)` to avoid float precision loss over long sessions.

**Bandwidth.** `fc = clamp(0.06 * f0, 6, 45)`. This is the one real tuning knob. It sets the
capture range: roughly ±100 cents at the higher strings, ±150 cents at cello C2 where the clamp
binds. It must be narrow enough to reject the neighbouring strings (a fifth away — 702 cents,
never close) and the bowed string's own upper partials, and wide enough to track a drifting pitch.

**Second demodulator at 2·f0.** Run a parallel demodulator on the first overtone. Its phasor
rotates at twice the error rate, doubling angular resolution, and overlaying two phasors at a 2:1
rate ratio is what produces genuine rosette figures rather than a plain circle. **Gate it off when
`|cents| > 25`** — beyond that it aliases at the message rate and just adds visual noise, and it is
precisely inside 25 cents that the extra resolution is wanted.

**Message rate.** Post `[i1, q1, i2, q2]` every 4th render quantum (512 samples ≈ 10.7 ms ≈ 94 Hz).
Legitimate to decimate this hard because I/Q are bandlimited to `fc`. At large errors the phasor
undersamples and the figure looks ragged — acceptable, the numeric readout carries that case.
Do not use `SharedArrayBuffer`; it needs COOP/COEP headers and four floats is nothing.

## Error estimate

`θ = atan2(q, i)`, unwrapped across messages. Estimate `dθ/dt` by **least-squares slope over a
sliding ~0.5 s window** (48 samples at 94 Hz), maintained with running sums — not by differencing
consecutive samples, which is dominated by noise.

```
Δf = slope / (2π)
cents = 1200 * Math.log2(1 + Δf / f0)
```

Sanity anchor for tests: 1 revolution per second at A440 is exactly **3.93 cents**. So 0.1 cent is
one revolution every 40 seconds — plainly visible, and better than any needle tuner.

## Target frequencies

Reference A is user-set, default 440, range 392–466 in 0.5 Hz steps. Temperament is selectable,
**pure fifths by default** (this is what string players actually tune, and it is the interesting
half of the app).

Pure: successive fifths are exactly 3/2. Equal: 2^(7/12). The two differ by 1.955 cents per fifth,
so the outer strings diverge audibly — G3 is 3.91 cents flat of equal, viola/cello C is 5.87 cents
flat. Derive everything from the reference rather than hardcoding tables.

| | pure @ A440 | equal @ A440 |
|---|---|---|
| Violin G3 / D4 / A4 / E5 | 195.556 / 293.333 / 440 / 660 | 195.998 / 293.665 / 440 / 659.255 |
| Viola C3 / G3 / D4 / A4 | 130.370 / 195.556 / 293.333 / 440 | 130.813 / 195.998 / 293.665 / 440 |
| Cello C2 / G2 / D3 / A3 | 65.185 / 97.778 / 146.667 / 220 | 65.406 / 97.999 / 146.832 / 220 |

Cello and viola anchor on A3 = ref/2 and A4 = ref respectively; build the rest downward by fifths.

## Rendering

Canvas 2D, DPR-aware, square, `rAF`-driven. Plot

```
x = i1 + 0.4 * i2
y = q1 + 0.4 * q2
```

normalized by a slow amplitude follower (fast attack, slow release) so the figure holds a stable
radius regardless of bow pressure — otherwise it collapses toward the centre as the note decays
and reads as "in tune" when it is merely quiet.

**Decay trails.** Draw to an offscreen canvas that is never cleared; each frame composite a
translucent background `fillRect` over it (alpha ≈ 0.03, ≈ 0.8 s time constant) before drawing the
new segment. This gives true harmonograph persistence far more cheaply than keeping and restroking
a point buffer.

Read behaviour: a perfectly tuned string parks the figure; error walks it around at `Δf` Hz.
Direction of rotation gives sign of error, so no separate sharp/flat indicator is strictly needed —
include one anyway as text.

**Amplitude gate.** Below the noise floor, freeze the figure and enter a dimmed "listening" state.
A frozen stale figure that looks in-tune is the main way this class of app lies to you.

### Layout

Information-dense, one screen, no scrolling:

- **Top bar** — instrument segmented control (Violin / Viola / Cello); reference A stepper;
  temperament toggle (Pure / Equal).
- **Centre** — the figure, as large as fits.
- **Corner overlays** — locked string name (large), target Hz, measured Hz, cents to 0.1 with sign.
- **Bottom** — four chips, one per string, each showing that string's last measured cents. This is
  the quartet-useful view: the whole instrument's state at a glance after one pass across the
  strings.

Colours from the starter's CSS variables; light and dark must both work.

## Visualization tuning

Add this **after** the skeleton measures correctly, and keep it behind `?dev=1` — the shipped UI
stays at three controls (instrument, reference A, temperament). A tuner with fourteen sliders is a
worse tuner.

**Split the knobs by kind, and do not put them in one list.**

*Taste* — free to fiddle, cannot produce a wrong reading:

| | default |
|---|---|
| trail composite alpha (decay time constant) | 0.03 (≈0.8 s) |
| 2·f0 overlay weight | 0.4 |
| overlay gate threshold | 25 cents |
| radius AGC attack / release | fast / slow |
| stroke width, colour ramp along the trail, glow | — |

*Measurement* — changes what the app reports, belongs in a separately labelled group, and every
control in it must display its effect on the cents readout and settling time next to itself:

| | default |
|---|---|
| demodulator bandwidth `fc / f0` | 0.06 |
| LSQ slope window | 0.5 s |
| amplitude gate threshold | — |
| detection hysteresis (dB, blocks) | 6 dB, 3 |

**Record and replay, don't adjust live.** Bowing while dragging a slider conflates the parameter
change with the bow change, which is how these sessions go in circles. Capture ~15 s of raw mono
mic PCM to an in-memory buffer (15 s float32 at 48 k ≈ 2.9 MB — keep it in memory, no
`localStorage`), then replay it deterministically through the worklet. Raw PCM rather than captured
I/Q, so that `fc` and the demodulator itself stay variable under replay.

Give the buffer a download button emitting a raw `.f32` plus a sidecar JSON of `{sampleRate,
instrument, string, refA}`. A recording of a real bowed cello C2 committed as a fixture is worth
more than any synthetic test in this repo — wire it straight into the headless suite as an
additional case.

**Compare, don't remember.** With replay in place, render a 2×2 grid of the same buffer under four
parameter sets simultaneously rather than one figure you adjust and try to recall. Convergence by
comparison, in one screen.

The panel's output is a JSON blob of the current values, pasted back into a single `VIZ` const in
source. The constants ship; the panel does not need to.

## Self-test mode

Claude Code cannot bow a violin, so ship a synthetic source: `?test=1&cents=3.93` swaps the
`MediaStreamSource` for an `OscillatorNode` at `target * 2 ** (cents / 1200)`, optionally summed
with 2nd and 3rd partials at −6 and −12 dB. Acceptance: the figure completes exactly one revolution
per second and the readout settles at 3.93 ± 0.05 cents.

## Headless tests

Keep the DSP as one source of truth in the worklet file, and have a Node harness run it under `vm`
with `AudioWorkletProcessor`, `registerProcessor`, `currentTime` and `sampleRate` stubbed,
capturing the registered class. No build step, no duplicated math.

Assertions, all on synthetic input:

1. Exact tone at target → `|cents| < 0.05`, phasor angle static.
2. Tone at +3.93 cents from A440 → estimated `Δf` = 1.00 ± 0.01 Hz.
3. Tone at −20 cents on cello C2 → correct sign, magnitude within 0.5 cents.
4. Detection: synthesized D4 with 6 partials → locks D, not G, not A.
5. Detection: D4 at −80 cents → still locks D (bandwidth check).
6. Silence → gate closes, no NaN out of `atan2` or the unwrapper.
7. Sample-rate independence: run every case at 44100, 48000, 16000.

## iOS specifics

These are the ones that will actually bite:

- **Kill the DSP chain**: `echoCancellation: false, autoGainControl: false, noiseSuppression: false`
  in the `getUserMedia` audio constraints. Safari enables all three by default and AGC destroys
  phase coherence.
- **Never hardcode 44100.** Read `ctx.sampleRate` (and `sampleRate` inside the worklet). iOS gives
  48 k on newer devices and can drop the mic path to 16 k or 8 k under some constraint combinations.
- `await ctx.audioWorklet.addModule(...)` before constructing the node.
- `ctx.resume()` requires a user gesture — gate on an explicit Start button.
- **Standalone mode is the fragile part.** Home-screen PWAs have historically been worse than a
  Safari tab for `getUserMedia` persistence: re-prompts on relaunch, occasional silent failure.
  Test installed-to-home-screen early, not after the app is finished.
- Request a **Screen Wake Lock** while tuning; re-request on `visibilitychange`, since the lock is
  dropped on backgrounding.
- Handle mic permission denial and `NotAllowedError` with real UI, not a console message.

## Starter integration

- Add `tuner-worklet.js` to the `sw.js` precache list and **bump `V`**. A worklet fetched via
  `addModule` is a normal same-origin request; if it is missing from the precache the app breaks
  offline in a way that looks like a DSP bug. Run `scripts/sw-lint.py` — it exists to catch this.
- Keep the flat root layout (`app.js`, `styles.css`, …). New files: `tuner-worklet.js`,
  `tuner.js` (graph setup, detection state, UI wiring), plus test harness under `tests/`.
- Persist instrument, reference A and temperament in `localStorage`.
- Enable the pre-commit hook: `git config core.hooksPath .githooks`.

## Parameter panel (dev-gated)

Build this once the skeleton renders, not before. Two classes of parameter, and they get different
treatment — a settings screen that exposes the DSP constants is a way to let the user make the
tuner quietly wrong.

**Aesthetic — ship these, persist to `localStorage`:** trail decay alpha (0.01–0.12), stroke width,
overtone mix weight (default 0.4), amplitude-follower release, figure orientation offset, colour
mapping (static vs hue-by-error-sign).

**Correctness — calibrate, then bake into source:** bandwidth coefficient (`0.06`), LSQ window
length (0.5 s), detection hysteresis (6 dB × 3 blocks), message decimation (4 quanta), 2·f0 gate
(25 cents). These trade accuracy against latency and lock stability. They have right answers, and
the right answers do not depend on taste.

**Mechanism.** One declarative object holds default, min, max, step and class per parameter; the
panel is generated from it, so adding a knob is one line and the defaults have a single home.
Reveal the panel on `?dev=1` only. Sync live values into the URL hash so a configuration you like
is a link you can text yourself, and add a **Copy as JS** button that emits only the parameters
differing from default, ready to paste back into source.

**Make the correctness half a measurement, not an eyeball.** In dev mode display, over a rolling
2 s window: cents standard deviation, lock-drop count, and gate-close count. Then sweep the
bandwidth coefficient against a sustained real note and take the lowest value whose jitter stops
improving but which doesn't drop lock under vibrato. That turns the one unverifiable constant in
this plan into a minimum on a curve you can see, and the numbers you settle on get hardcoded and
the knob deleted.

## Non-goals for v1

Double-stop / coincident-partial interval mode (the phasor math generalizes to it later — leave the
demodulator's target frequency a free parameter so it can). Chromatic mode. Stopped-note intonation
training. Recording or session history. Bass or guitar. Any backend.

## Known risks

- **Cello C2 at 65 Hz** is the hardest case: phone mics roll off steeply below ~100 Hz, so the
  fundamental may be weaker than its 2nd partial. If detection or lock is unreliable there, fall
  back to demodulating C2 at 2·f0 and halving the reported `Δf` — the phase relationship is
  preserved, and this costs nothing but a factor.
- The `0.06 * f0` bandwidth constant is a guess: too wide and the figure jitters from partial
  bleed, too narrow and the lock drops during vibrato or a pitch sweep. Resolve it with the
  jitter/lock-drop readout above against a real bowed instrument, then hardcode the result — this
  is the only number in the plan that can't be derived.
- Bow noise on attack can briefly beat the Goertzel scores; the 3-block hysteresis is the mitigation
  and may need lengthening.
