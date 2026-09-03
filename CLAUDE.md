# CLAUDE.md — Lissajous Tuner

Briefing for Claude Code in this repo. Read `Lissajous-Tuner.md` (the plan) and `ADDENDUM.md`
(four corrections that supersede it) before touching DSP. This file records what was learned
BUILDING it — the things neither document says, and the places both turned out to be wrong.

## Shape

Zero-build static PWA from [pwa-starter](https://github.com/jsundram/pwa-starter). Flat root, no
bundler, no npm runtime deps. `package.json` is dev-only (`private: true`) and names the harnesses.

| file | owns |
|---|---|
| `tuner-worklet.js` | **all** DSP: detection, demod, unwrap, slope, follower, gate |
| `tuner.js` | audio graph, settings, the `PARAMS` table |
| `app.js` | renderer + UI wiring. Does no arithmetic on phase |
| `strings.js` | target frequencies, derived not tabulated |
| `build.js` | GENERATED. Never hand-edit |

**The boundary is load-bearing** (ADDENDUM §1): the worklet posts `{s,c,th,r,st,x,y}` render-ready
at ~94 Hz. The main thread never needs `sampleRate` or a DSP constant. The tests assert against
those messages, so moving estimation back across the line means rewriting both.

## Verify with

```sh
node --test tests/*.test.mjs     # 35 DSP cases at 44100/48000/16000
node scripts/sw.test.mjs         # 22 service-worker fetch-handler cases
python3 scripts/sw-lint.py       # precache contract
node scripts/browser-check.mjs   # real Chromium, ?test=1 (needs a local server)
node scripts/offline-check.mjs   # prime, go offline, confirm it still runs
```

`tests/harness.mjs` loads `tuner-worklet.js` under `vm` with the AudioWorklet globals stubbed. The
DSP has exactly one copy; keep it that way.

## Deploying

**`./scripts/deploy.sh "message"` — do not push by hand.** It verifies, commits the code, then
bumps `V` and restamps `build.js` *in one commit*. That order is deliberate and non-obvious:
`build.js` records the SHA of the commit holding the code (unknowable until it exists, hence two
commits), but `build.js` is itself precached, so bumping `V` in the earlier commit tripped
`sw-lint` on every deploy. Bump and stamp travel together.

**Three taps on the build id opens the dev panel.** An installed PWA has no URL bar, so `?dev=1`
cannot be typed once it is on the home screen — which is exactly where it needs calibrating against
a real instrument. `?dev=1` still works in a tab.

The build id renders in the corner **at all times**, not just under `?dev=1`. A trailing `+` means
the tree was dirty at stamp time. `scripts/stamp-build.sh --deploy` suppresses that and only
`deploy.sh` passes it.

## Things that are true and cost time to find

- **Detection scores a HARMONIC SUM over ±150-cent bands.** Three constraints collide: a single bin
  can't be wide enough for a ±100-cent-flat string (39 Hz at E5) *and* narrow enough to separate
  cello C2 from G2 (32.6 Hz apart), and a *wide* band catches the neighbours' partials. At ±300,
  E5's band was 555–785 Hz, which contains G3's 3rd and 4th partials (587, 782) — a real violin's
  **open G read as E5**, because its fundamental is weak (the body barely radiates 196 Hz and phone
  mics roll off there). ±150 catches neither, and summing `k = 1..detHarmonics` weighted 1/k means
  a rolled-off fundamental no longer loses the string. **Both halves are needed** — with the narrow
  band but `detHarmonics: 1` it mislocks to A4 on leakage from G3's strong 2nd partial. Bands stay
  disjoint from each other because strings are fifths (702 cents), so anything under ±351 is safe.
- **Never score a bare 2·f0 octave probe.** `G2 = 1.5·C2` means `2·G2 = 3·C2` exactly, so it lands
  on the third partial of the string below. The harmonic sum is the principled version: requiring
  the whole series to line up removes that degeneracy.
- **Past ±150 cents nothing can lock**, so the demodulator hears nothing and the gate closes. That
  must not read as silence when the player is bowing: `unattributedRms` compares the RAW input
  level and reports `st: 3` (out of range) rather than `st: 0` (listening).
- **ADDENDUM §3's "~187 Hz" unwrap ceiling is the 48 kHz figure.** The quantum is 128 *samples*, so
  the ceiling scales with sample rate — 62.5 Hz at the 16 kHz path iOS can hand you, which aliases
  a 250-cent error into a plausible wrong number. Unwrap runs every `UNWRAP_STRIDE` (32) samples to
  decouple it. Do not tie the unwrap rate back to the quantum.
- **The plan's decay-trail technique does not work in 8-bit canvas.** A translucent `fillRect` fade
  moves a channel by `alpha*(target-current)`, which rounds to zero once the gap is under
  ~`1/(2*alpha)`. It stalls and every stroke leaves a permanent scar. `app.js` keeps a point buffer
  and restrokes (~75 segments; the plan overestimated the cost). Capture points in the ESTIMATE
  handler, never in the rAF loop — sampling at 60 fps drops a third of a 94 Hz stream.
- **Each message carries the whole sub-quantum path** (`PATH_PER_MSG`, 16 points), not one point.
  One point per message is enough to MEASURE — I/Q are bandlimited — but the figure is a path, and
  at a 5 Hz beat 94 Hz gives ~18 points per revolution, which draws as a polygon. The points are
  already computed for the unwrapper, so this costs 128 bytes a message. `drawFrame` strokes them
  as `TRAIL_CHUNKS` constant-alpha polylines: ~3200 live points would otherwise be 3200 draw calls
  a frame.
- **While a reference tone sounds the mic hears OUR tone**, so the tuner would lock that string and
  report ~0.0 cents — indistinguishable from a perfectly tuned instrument. `paintEstimate` returns
  a reference state instead of a reading. Do not "fix" this by letting the number through.
- **The figure's SHAPE means nothing about pitch** (ADDENDUM §4). A 2:1 ratio traces a fixed
  limaçon. Shape is timbre, motion is error. No UI copy may imply otherwise.
- iOS: `apple-mobile-web-app-status-bar-style` must be `default`. `black-translucent` forces white
  status-bar text, invisible against the light theme.
- The zero-gain `GainNode` to `destination` is required, not decorative — Safari stops pulling an
  unconnected worklet and `process()` silently stops.

## Open

- **`bwCoef` (0.06) is still a guess.** It is the one number the plan admits cannot be derived. Use
  `?dev=1`: record 15 s of a real bowed note, replay it, and sweep the bandwidth against the jitter
  / lock-drop / gate-close readouts. Take the lowest value whose jitter stops improving but which
  doesn't drop lock under vibrato, then hardcode it and delete the knob.
- Cello C2 detection on a real phone mic is unverified — the fundamental may be rolled off. Read
  the `detH2Weight` warning above before reaching for it.
- Not built: the 2×2 parameter-comparison grid from the plan's visualization section.
