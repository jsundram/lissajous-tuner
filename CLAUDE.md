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

The build id renders in the corner **at all times**, not just under `?dev=1`. A trailing `+` means
the tree was dirty at stamp time. `scripts/stamp-build.sh --deploy` suppresses that and only
`deploy.sh` passes it.

## Things that are true and cost time to find

- **Detection is scored over a BAND (±300 cents), not one bin.** A single bin cannot be both wide
  enough for a ±100-cent-flat string (39 Hz at E5) and narrow enough to separate cello C2 from G2
  (32.6 Hz apart). Bands work because strings are fifths — 702 cents — so any half-width under 351
  keeps neighbours disjoint. The block length is derived from the closest candidate pair.
- **Never add a 2·f0 term to the DETECTION score.** `G2 = 1.5·C2` means `2·G2 = 3·C2` exactly, so an
  octave probe lands on the third partial of the string below. `detH2Weight` exists, defaults to 0,
  and should stay there. Octave help for *tracking* is safe and already present (the 2·f0 blend).
- **ADDENDUM §3's "~187 Hz" unwrap ceiling is the 48 kHz figure.** The quantum is 128 *samples*, so
  the ceiling scales with sample rate — 62.5 Hz at the 16 kHz path iOS can hand you, which aliases
  a 250-cent error into a plausible wrong number. Unwrap runs every `UNWRAP_STRIDE` (32) samples to
  decouple it. Do not tie the unwrap rate back to the quantum.
- **The plan's decay-trail technique does not work in 8-bit canvas.** A translucent `fillRect` fade
  moves a channel by `alpha*(target-current)`, which rounds to zero once the gap is under
  ~`1/(2*alpha)`. It stalls and every stroke leaves a permanent scar. `app.js` keeps a point buffer
  and restrokes (~75 segments; the plan overestimated the cost). Capture points in the ESTIMATE
  handler, never in the rAF loop — sampling at 60 fps drops a third of a 94 Hz stream.
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
