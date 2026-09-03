# Lissajous Tuner

A phase-coherent tuner for violin, viola and cello. It shows tuning error as a **rotating figure**
rather than a needle: a perfectly tuned string parks the figure, and error walks it around at the
beat frequency. One revolution per second at A440 is 3.93 cents, so a tenth of a cent is one
revolution every 40 seconds — plainly visible, and finer than a needle can resolve.

Zero-build static PWA on GitHub Pages, built on [pwa-starter](https://github.com/jsundram/pwa-starter).
No bundler, no `src/`, no npm runtime dependencies.

**Live:** https://jsundram.github.io/lissajous-tuner/

## How it works

Not an FFT. `AnalyserNode` returns magnitudes and throws away phase, and phase *is* the signal —
FFT resolution is capped by window length, while watching a phase difference drift is unbounded.

The app is quadrature demodulation: multiply the mic signal by a locally generated sine/cosine pair
at the target frequency, lowpass both, and the resulting vector's **angle** is the phase offset
while its **rotation rate** is the frequency error in Hz. Reference and signal come from the same
`AudioContext` at the same `sampleRate`, so there is no clock drift between them — otherwise the
accuracy ceiling.

The figure itself is the f0 phasor composited with a 0.4-weighted phasor at 2·f0. That 2:1 ratio
traces a fixed **limaçon**, so its *shape* reads as timbre (your string, bow and instrument) and its
*motion* reads as tuning error. The shape does not encode pitch — see `ADDENDUM.md` §4.

## Layout

Flat, deployable root — every file at the top level ships to the browser:

| | |
|---|---|
| `index.html` `styles.css` `app.js` `theme.js` | the page, its looks, boot, and theming |
| `tuner.js` | audio graph setup, detection state, UI wiring |
| `tuner-worklet.js` | **all** the DSP: detection, demodulation, unwrap, slope, gating |
| `sw.js` `manifest.json` | offline + installability |
| `assets/` | `icon.svg` / `og.svg` are the sources of truth; PNGs are generated |
| `scripts/` | tooling that never ships (rasterizers, lints, tests) |
| `tests/` | the headless DSP harness |

The worklet is the single source of truth for the math. The main thread renders and nothing else —
it never needs `sampleRate` or any DSP constant.

## Development

```sh
npm run serve                 # static server on :8137 (getUserMedia needs localhost or HTTPS)
npm test                      # DSP suite + service-worker suite + precache lint
npm run check:browser         # real Chromium via ?test=1 — needs `npm install` and a server
npm run check:offline         # prime the cache, go offline, confirm it still runs
```

The DSP suite needs nothing installed. The two `check:` scripts drive a real browser, so they need
`npm install` (a `playwright-core` devDependency; the browsers themselves come from
`npx playwright install chromium`). Nothing in `node_modules` is ever deployed.

**Deploy with `npm run deploy -- "message"`,** never by hand — it verifies, then bumps the
service-worker cache generation and restamps the build id in one commit. Skipping it ships a fix
that never reaches an installed phone.

Enable the pre-commit guard once per clone:

```sh
git config core.hooksPath .githooks
```

### URL flags

| | |
|---|---|
| `?test=1&cents=3.93` | replace the mic with a synthetic tone at that error — no violin required |
| `?dev=1` | parameter panel, jitter / lock-drop / gate-close readouts, record + replay |

### Regenerating art

`assets/icon.svg` and `assets/og.svg` are **generated**, not hand-drawn — both come from the same
curve the app plots, so the mark can't drift from the thing it depicts:

```sh
node scripts/make-figure.mjs      # -> assets/icon.svg + assets/og.svg
./scripts/make-icons.sh           # -> icon-180/192/512.png
./scripts/make-og.sh              # -> og.png (hard-fails over 250 KB)
```

## Toolchain

Build-time only; the deployed app has no dependencies.

| tool | for |
|---|---|
| `rsvg-convert` (librsvg) | rasterizing icons + share card |
| `pngquant` | compressing the share card under the scrape budget |
| `node` | DSP tests, sw tests, figure generation |
| `python3` | `sw-lint.py`, `og-lint.py`, local server |

`tools/setup-environment.sh` checks these and is wired to a `SessionStart` hook.
