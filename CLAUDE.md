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

node scripts/analyze-recording.mjs take.m4a --expect G3,D4,A4,E5   # a REAL recording, second by second
node scripts/analyze-recording.mjs take.m4a --track A4            # ...cross-checked independently
```

`analyze-recording.mjs` decodes anything ffmpeg can read, feeds it to `tuner-worklet.js` itself, and
prints lock / state / cents / level **and every candidate's detection score in dB** per half second.
Every other fixture in this repo is synthetic; this is the one that uses the actual instrument in the
actual room. It also reads the app's own single-`.wav` captures, sidecar and all. `--save` writes
the `.f32` + `.json` pair `tests/harness.mjs` reads, so a recording that shows a failure becomes a
regression test in one more step.

**`--track <string>` is the cross-check, and it is what to reach for whenever the question is "is the
app wrong, or is the instrument doing that".** It prints an independent estimate beside the app's: a
harmonic comb with no demodulator, no lock and no ±150-cent band, so it shares no machinery with the
thing being measured. Grading the estimator with itself cannot answer that question, and two of this
repo's findings turned on it. Its scan stays under ±351 cents on purpose — the strings are pure
fifths, so a wider one finds the NEIGHBOUR and reports a confident −702.

`tests/harness.mjs` loads `tuner-worklet.js` under `vm` with the AudioWorklet globals stubbed. The
DSP has exactly one copy; keep it that way.

## Deploying

**`./scripts/deploy.sh "message"` — do not push by hand.** It verifies, commits the code, then
bumps `V` and restamps `build.js` *in one commit*. That order is deliberate and non-obvious:
`build.js` records the SHA of the commit holding the code (unknowable until it exists, hence two
commits), but `build.js` is itself precached, so bumping `V` in the earlier commit tripped
`sw-lint` on every deploy. Bump and stamp travel together.

**The loopback sweep is near-useless on an iPhone, and that is not a bug in the microphone.** While
a `getUserMedia` stream is live, iOS routes output to the EARPIECE rather than the speaker, so the
app can barely hear its own tone — a real device reported 0% lock on all four rows. A bare sine at
G3 (196 Hz) is nearly inaudible from a phone speaker anyway. Read the `mic` column (raw input RMS)
FIRST: if it is near zero the test did not run, and every other column is meaningless. For real
answers about microphone response, bow the instrument and watch `mic rms` / `demod amp` live.

**Loopback sweep** (dev panel) plays each string's reference tone and reports what the mic + detector
made of it — play/hear/cents/jitter/lock%/level/mic. It is the only test that covers speaker → room →
mic → detector, the path that produced the open-G misdetection, and its `level` column IS the
microphone's response across the strings. Meaningless under `?test=1` (that measures the synthetic
oscillator), and the panel says so. Dev mode deliberately stops suppressing the readout while a
reference tone sounds, labelling it `loopback · <string>`; **non-dev must keep suppressing it**, or
the app reports ~0.0 cents off its own tone and looks like a perfectly tuned instrument.

Nothing may be `position: fixed` over the chips row — they are buttons now, and an overlay there
swallows taps meant for a control. The dev pill lives in `.statusrow` for exactly this reason.

**The open dev panel covers the pill AND the build id** (it is fixed to the bottom 72dvh, and the
status row sits inside that). So every way OUT of dev mode must live inside the panel itself, in the
sticky `.dev-head` — for one release it did not, and opening the panel on a phone was a dead end
with no way back short of relaunching. `setPanelOpen()` is the single owner of open/closed; the
pill, the triple-tap gesture and the header's Collapse all go through it.

**Record 15 s writes ONE `.wav`,** 32-bit float, with the whole sidecar (rate, instrument, locked
string, every parameter) in a RIFF INFO comment chunk. It used to emit a `.f32` and a `.json` back to
back; on an installed iOS PWA two downloads in one gesture do not both survive, and the half that got
lost was the audio — the only half that cannot be reconstructed. `analyze-recording.mjs` reads the
comment back, so a phone recording needs no second file.

`Exit dev` (not Collapse) is the full exit: it removes the pill, empties the panel, clears
`devMode` — which restores reference-tone suppression — and strips `?dev=1` from the URL so the
exit survives a reload.

**Dev mode is ON by default until the first release** (`?dev=0` turns it off, and that is what
`Exit dev` writes into the URL so the exit survives a reload — it used to DELETE the flag, which
under the new default would silently re-enable dev). Everything still needing calibration against a
real instrument lives behind it, and asking someone holding a violin to type a query string into a
phone is how a calibration session does not happen. The panel carries its own ordered instructions
and a live **Detection** table showing every candidate's score in dB — that table is what turns "the
G string doesn't work" into a one-line diagnosis, because a string that is sounding but losing the
lock appears AS a number rather than as an absence. Flip the default back in `tuner.js FLAGS.dev`.

**Three taps on the build id opens the dev panel.** An installed PWA has no URL bar, so `?dev=1`
cannot be typed once it is on the home screen — which is exactly where it needs calibrating against
a real instrument. `?dev=1` still works in a tab.

The build id renders in the corner **at all times**, not just under `?dev=1`. A trailing `+` means
the tree was dirty at stamp time. `scripts/stamp-build.sh --deploy` suppresses that and only
`deploy.sh` passes it.

## Things that are true and cost time to find

- **Detection scores a COMB over ±150-cent bands, combined as a geometric mean.** Three constraints
  collide: a single bin can't be wide enough for a ±100-cent-flat string (39 Hz at E5) *and* narrow
  enough to separate cello C2 from G2 (32.6 Hz apart), and a *wide* band catches the neighbours'
  partials. At ±300, E5's band was 555–785 Hz, which contains G3's 3rd and 4th partials (587, 782)
  — a real violin's **open G read as E5**, because its fundamental is weak (the body barely radiates
  196 Hz and phone mics roll off there). ±150 catches neither.
- **The sticky lock, and why per-harmonic maxima were the cause.** The first fix scored each
  candidate by summing an INDEPENDENT peak per harmonic band, weighted 1/k. That let every candidate
  pick, per harmonic, whichever nearby foreign partial was loudest — and the margins between
  fifth-related strings collapsed to **1.6–5.7 dB against a 6 dB `hystDb`**. Nine of the twelve
  string-to-string transitions were unreachable *by construction*: a real G–D–A–E sweep on video read
  "G3 / out of range" for 32 of its 35 seconds. Every test passed, because every test bowed one
  string into a fresh tuner — the one thing a player never does.
  The measured cause is BIN WIDTH, not offset: cello D3's k=1 band is 134–160 Hz and its bottom probe
  sits 3 Hz from C2's second partial at 130.8, inside one 11.7 Hz bin. No band width, window or
  offset separates that; only a longer block would, and 0.34 s blocks make string changes visibly
  slow. Three changes, together worth 1.6 → 9.4 dB worst case:
  1. **One shared offset** (a comb), since a mistuned string shifts every harmonic by the same cents.
  2. **Geometric mean, not a sum**, with a penalty per absent harmonic. A sum lets one huge term
     carry a candidate; a geometric mean makes every member have to be present. Flat weights — 1/k
     re-inflates the fundamental and loses the rolled-off cello C2 (3.4 dB weighted, 8.3 flat).
  3. **The floor is a fraction of the BLOCK's energy, not of the candidate's own peak.** Relative
     flooring compares floors when the signal is a pure sine with no partials, and a 440 Hz tone duly
     locked G3 (whose k=2 band edge is 0.6 bins away) instead of A4. A tuning fork must not do that.
- **Automatic detection answers the wrong question while you are TUNING.** Confirmed on real
  recordings of tuning each string by fifths: a 27-second "tune the G string" take reads **D4 for 18
  of those seconds**, and it is not wrong to — the D really is 20–40 dB louder at the microphone
  than the G. Tuning by fifths means bowing the NEIGHBOUR as your reference for much of the session,
  so "what is loudest" and "which peg am I turning" are different strings most of the time. Hence
  **pinning**: tap a chip to lock the tuner to one string and stop detecting, tap again to release.
  Detection answers "what am I playing"; only the player knows the other. Nothing in the DSP may
  override a pin — not the hysteresis, not the deaf-lock escape hatch.
- **Chips: tap pins, hold (450 ms) plays the reference tone.** The tone used to be the tap action.
  Pinning took it because it is what you need while actually turning a peg, and the screen has no
  room for a second control per string. `wireChip()` owns the gesture; it swallows the synthetic
  click after a hold so the tone is not immediately toggled off again.
- **`hystDb` is 3, and must not go back to 6.** It is now BELOW the measured margins rather than
  above them. Raising it past ~5 re-creates the sticky lock; re-measure the 4×4 margin matrix first.
- **A deaf lock releases itself** after `unlockSec` (0.25 s): gate shut while the raw input is loud
  means we are locked to a string that does not explain what is being played, and hysteresis exists
  to protect a lock that is WORKING. This is the escape hatch that does not depend on detection
  margins, which are a property of the instrument and the room. Loud-but-unattributable reports
  `st: 3` whether or not anything is locked — tying that to the lock made a 250-cent-flat string read
  as silence the moment the lock dropped.
- **The violin G arrives 20–40 dB below the D and A**, measured, not assumed — `amp1` around
  4e-3 against 1e-1 on the same take, at ~3–6x the 0.0012 gate. That is the whole reason the G
  string is fragile: a quieter room or the phone a foot further away puts it under the gate. It is
  also why `MISS_PEN_F0` is deliberately mild and why `detHarmonics` must stay at 4.
- **Never score a bare 2·f0 octave probe.** `G2 = 1.5·C2` means `2·G2 = 3·C2` exactly, so it lands
  on the third partial of the string below. The comb is the principled version: requiring the whole
  series to line up removes that degeneracy.
- **The 2·f0 leg may only open the gate THROUGH the octave guard, never beside it.** Guarding the
  estimate is not enough: a violin playing D5 while locked to the open D read "D4, about in tune",
  an octave out, because amp2 alone was allowed to open the gate. `gated` is
  `amp1 < gateAmp && !starved`, and `starved` carries the guard. Found on a real recording, not by
  reasoning — the narrower gate this replaced had been hiding it by accident.
- **Wait `SETTLE_TC` time constants after any demodulator reset before believing the output.** A
  zeroed 4-pole cascade struck by a strong OUT-OF-BAND tone rings enough to clear the noise gate,
  and the estimator reports what the ringing looks like: +50 cents on a tone 250 cents off. Since
  every string change resets the cascade, this is also what stops a wrong number flashing on screen
  as the lock moves.
- **The gate is on EITHER demodulator leg, and the 2·f0 leg needs an octave guard.** A phone mic can
  put a plainly-sounding open G's fundamental under `gateAmp` while its second partial is 20 dB
  above it; gating on `amp1` alone reported that as silence. So when f0 is starved and 2·f0 is not,
  the 2·f0 estimate carries the reading outright (no crossfade — there is nothing on the f0 side
  worth blending) and the figure's phasor is synthesized from the 2·f0 phase HALVED, which has the
  same rotation rate and direction. But that path reopened the octave hole immediately: a bare
  570 Hz tone read as "D4, 46 cents flat". The guard is that detection must have seen the string's
  **third harmonic** — an odd partial is the one thing a tone sitting at 2·f0 cannot supply.
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
- **The reference outline is an ORBIT, not a target to match.** `targetGuide` draws
  `x = cos(q*u), y = sin(p*u)` faintly behind the figure — a unit circle for the phasor and the
  unison Lissajous, the string's p:q lattice for figure 2. What it honestly gives you is the centre,
  the scale, and the lobe structure to expect. It is NOT "the shape when in tune": being in tune
  makes the figure STAND STILL at whatever phase it happens to hold, and mode 1's in-tune ellipse
  ranges from a straight line to a circle depending only on where the phase started. No copy may
  say "match the outline". Drawn in `app.js`, not the worklet — static geometry from an integer
  ratio needs no sampleRate and no DSP constant, so the estimation boundary is untouched.
- **The figure's SHAPE means nothing about pitch — in `figureMode: 0`** (ADDENDUM §4). A 2:1 ratio
  traces a fixed limaçon. Shape is timbre, motion is error. No UI copy may imply otherwise.
- **...but there are now two true-Lissajous modes, and in those the shape IS the string.** This was
  asked for directly: the expectation was a figure of the reference against the microphone, which is
  not what the phasor is. `figureMode` 1 draws `x = cos(u)` against the narrowband microphone
  reconstructed from I/Q — the classic tuning ellipse, still when in tune, cycling line → circle →
  line once per beat Hz, the same on every string. `figureMode` 2 draws each string's integer ratio
  to the reference A (violin D 2:3, E 3:2, G 4:9) and the error shows as that shape PRECESSING.
  Both are built in the worklet from the same measured phasor the readout uses, so the boundary
  holds: the message carries `fk` (0 = trail to append, 1 = closed curve to replace) and `app.js`
  branches on that rather than on the parameter — a message posted before a mode change still
  renders as whatever it actually is. Ratios are integers only because the strings are pure fifths;
  in equal temperament a perfectly tuned string precesses slowly against the pure ratio, which is a
  true statement about the tuning rather than an artefact. `strings.js ratios()` owns them.
  Cello C2 is 4:27 against the A — honest, and an unreadable lattice. Say so rather than hiding it.
- iOS: `apple-mobile-web-app-status-bar-style` must be `default`. `black-translucent` forces white
  status-bar text, invisible against the light theme.
- The zero-gain `GainNode` to `destination` is required, not decorative — Safari stops pulling an
  unconnected worklet and `process()` silently stops.

## Working on look, feel and behaviour

**The loop.** `?test=1&cents=N` makes the figure deterministic — a synthetic tone a fixed number of
cents off — so a change is comparable across runs and needs no instrument. `--cents` also sets how
the figure *reads*: 3.93 is one revolution per second (slow, smooth), 50 is fast.

```sh
npm run serve                                             # :8137, in another shell
npm run shot -- --theme light --cents 3.93                # -> shot.png
npm run shot -- --w 375 --h 667 --instrument cello --dev
npm run shot -- --engine webkit                           # closest available thing to iOS Safari
```

`shot.mjs` exits non-zero on any page error, so a broken build cannot quietly produce a nice
picture. Use `--settle` if a cold browser start hasn't filled the trail yet.

**Design tokens** are the only place colour lives: `--bg --card --ink --muted --line --accent
--trace --sharp --flat` plus `--radius --maxw`, defined three times in `styles.css` (`:root`, the
`prefers-color-scheme: dark` block, and `:root[data-theme="dark"]`). **Keep the two dark blocks in
sync.** `sw.js`'s `offlineFallback()` hardcodes the palette by necessity — it renders when
`styles.css` is unreachable — so a palette change means editing it too.

**The canvas bakes colours into JS**, which is the classic theme trap here: `traceColor()` and
`bgColor()` read `Theme.getCssColor()`, whose cache `theme.js` clears *before* calling subscribers.
So anything that draws must repaint on `onThemeChange`, and must read colours through
`getCssColor`, never a literal.

**Layout ownership.** `#tuner` is a `100dvh` flex column: `.bar` (three controls) / `.stage` /
`.statusrow` (dev pill + build id) / `.chips`. `.stage` holds the canvas, `.hud` (corner overlays,
`pointer-events:none`) and `.overlay` (start / mic-error). Two load-bearing details: `.stage` needs
`min-height:0` or the flex child refuses to shrink and pushes the chips off-screen, and `.hud` is
hidden until `.stage.live` — empty captions before Start read as a broken screen.

**`VIZ_KEY` must be bumped whenever a DEFAULT changes.** `load()` lets a stored value win over the
default, so any device that ever touched a slider has the whole table frozen at that day's defaults
and a corrected default silently never arrives. `hystDb` 6 → 3 is exactly that case: the fix for the
sticky lock would not have reached the one phone it was diagnosed on. It is `lt-viz2` now.

**Adding a parameter is one line** in `tuner.js PARAMS`; the panel is generated from it. Give it
`choices: [[value, "Label"], ...]` and it renders as a segmented radio group instead of a slider,
reusing the same `.seg` control as the instrument and temperament pickers — an enum like
`figureMode` has nothing at 0.5 and a continuous slider invites dragging to it. `cls:
"taste"` ships and persists to localStorage, `cls: "measure"` is calibrate-then-bake, and
`worklet: true` forwards it to the DSP. Do not add a knob that can change the reported number
without putting it in `measure`.

**Behaviour that must not be "tidied away".** Each of these looks like a bug and is not:

- The figure **freezes** (does not decay) when gated or searching. A decaying figure erases the
  evidence of the last real reading; a frozen one that still looks in tune is why it also dims.
- Outside ±120 cents the app shows **no number at all**. That is deliberate (ADDENDUM §3).
- A reference tone shows a **reference state, not a reading**, outside dev mode. The mic is hearing
  the app's own tone and would report ~0.0 cents.
- The figure is **near-circular on a pure tone**. Dimple depth is `overlayWeight * (amp2/amp1)`, so
  shape follows the instrument's partials — that is the honest behaviour, not a missing feature.

**Overlay invariants**, learned three times the hard way: nothing `position: fixed` over `.chips`
(they are buttons); every exit from dev mode lives inside the panel, because the open panel covers
the pill and the build id; and watch cascade order — `.stage.live.gated .hud` has the same
specificity as `.stage.live .hud` and comes later, which is why the gated rule is scoped to
`.live`.

## Open

- **`bwCoef` (0.06) was a guess and is now MEASURED — the guess was right. Do not narrow it.**
  Swept against five real violin takes. Median per-second cents SD, steady passages:

  | bwCoef | 0.02 | 0.03 | 0.04 | 0.06 | 0.09 | 0.13 |
  |---|---|---|---|---|---|---|
  | capture | ±34c | ±51c | ±68c | ±101c | ±149c | — |
  | GDAE | 1.68 | 1.78 | 1.81 | 1.85 | 1.89 | 1.99 |
  | Tune G | 2.10 | 2.61 | 2.71 | 4.19 | 14.37 | 18.33 |
  | Tune E | 1.69 | 1.62 | 1.94 | 2.07 | 3.71 | 3.71 |

  Read alone that says "narrow it to 0.03", and that is a trap. Jitter is measured on STEADY notes;
  the tuning workflow is the opposite of steady. Against a real −94-cent peg turn, at the moment the
  pitch was falling fastest the same instant read **−34 at bwCoef 0.02, −59 at 0.03, −68 at 0.06**
  against a true −94: a narrower filter has a longer group delay, so it lags exactly when you are
  turning a peg and watching the number. Going wider is worse in the other direction — 0.09 puts
  Tune G's jitter at 14 cents. 0.06 sits in the trough of both costs, and its ±101-cent capture is
  the right match for `outOfRangeCents` (120).

  The plan wanted the lower bound decided by "does it drop lock under vibrato", and that turns out
  to be **the wrong question for this app**: nobody tunes with vibrato. The bound that matters is
  peg-turn lag, which is measured above and points the same way. Treat bwCoef as settled unless the
  app ever becomes a while-you-play monitor rather than a tuner, which would bring vibrato back.
- **`lsqSec` (0.5) is confirmed too, and 0.2 is actively worse** — Tune E 2.07 → 4.74, Tune A 4.42 →
  11.10. A shorter window feels more responsive and measures noisier; the lag it buys back is about
  `lsqSec/2`, which is ~0.25 s at the default. Verified directly: during a peg sweep the reading
  trails in whichever direction the pitch is moving and agrees to 0.4 cents once it settles.
- Cello C2 detection on a real phone mic is unverified — the fundamental may be rolled off. The
  harmonic sum should carry it; the **loopback sweep's `level` column** is how to check, and
  `detHarmonics` is the knob if it doesn't.
- The sticky-lock fix is **confirmed on a real violin**: a G–D–A–E take that read "G3" throughout on
  lt-v12 now finds all four strings, each within ~0.5 s. That was measured against recordings which
  are **deliberately not in the repo** (`recordings/` is gitignored — it is audio of a person, and
  this is public). So the confirmation is real but *not reproducible from a clean checkout*: ask for
  a recording rather than assuming one is on disk, and use `scripts/analyze-recording.mjs`. On the
  machine this was developed on, `recordings/` holds the G–D–A–E sweep, four by-fifths tuning takes,
  `D5-on-A-string-octave-case.wav` (the octave bug), and two screen captures.
- ~~Cents excursions of 40–90 cents during tuning~~ — **resolved: they are real, and the estimator
  tracks them correctly.** Checked with `analyze-recording.mjs --track`. On a
  peg-tuned A the tracker and the app agree throughout a −94-cent excursion; on an E tuned with the
  fine tuner ONLY, both stay inside +17/−13 cents for the whole take. The split between those two is
  the confirmation: the big swings appear exactly where a peg was turned and nowhere else. What is
  left is pure lag — the app trails in whichever direction the pitch is moving and agrees to 0.4
  cents once it settles, which is the least-squares window costing about `lsqSec/2`.
- The two Lissajous modes are **unjudged on a real instrument** — the choice between them and the
  phasor is a taste call that has to be made while actually tuning something. Once made, bake it in
  and delete the other two.
- The open-G fix was derived from the physics and synthetic partial profiles, **not confirmed on a
  real violin**. The loopback sweep is the confirmation; a mismatch in its `hear` column is the
  failure reappearing.
- Not built: the 2×2 parameter-comparison grid from the plan's visualization section.
