#!/usr/bin/env node
// Screenshot the running app — the loop for any look-and-feel change.
//
// The point is that ?test=1 makes the figure DETERMINISTIC: a synthetic tone a fixed number of
// cents off, so the same command always produces a comparable image and no instrument is needed.
// A given --cents also fixes how the figure reads: the beat is cents-dependent, so 3.93 draws a
// slow smooth curve (one revolution per second) and 50 a fast one.
//
//   npm run serve                                    # in another shell
//   node scripts/shot.mjs                            # default: 390x844 dark, +20 cents
//   node scripts/shot.mjs --theme light --cents 3.93
//   node scripts/shot.mjs --w 375 --h 667 --instrument cello --dev --out /tmp/x.png
//   node scripts/shot.mjs --url https://jsundram.github.io/lissajous-tuner/
//   node scripts/shot.mjs --engine webkit           # closest thing to iOS Safari
//
// Exits non-zero on any page error, so a broken build can't quietly produce a pretty picture.
import * as pw from "playwright-core";

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true) : dflt;
};

const opts = {
  url: arg("url", "http://127.0.0.1:8137/"),
  w: Number(arg("w", 390)), h: Number(arg("h", 844)),
  theme: arg("theme", "dark"),
  cents: arg("cents", "20"),
  instrument: arg("instrument", null),
  settle: Number(arg("settle", 2600)),
  dev: !!arg("dev", false),
  out: arg("out", "shot.png"),
  engine: arg("engine", "chromium"),
};

const engine = pw[opts.engine];
if (!engine) { console.error(`unknown --engine ${opts.engine} (chromium | webkit)`); process.exit(1); }

const launchArgs = opts.engine === "chromium"
  ? ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] : [];
const browser = await engine.launch({ args: launchArgs });
const page = await browser.newPage({
  viewport: { width: opts.w, height: opts.h },
  colorScheme: opts.theme === "light" ? "light" : "dark",
  isMobile: true, hasTouch: true, deviceScaleFactor: 2,
});

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

const q = new URL(opts.url);
q.searchParams.set("test", "1");
q.searchParams.set("cents", String(opts.cents));
if (opts.dev) q.searchParams.set("dev", "1");
await page.goto(q.toString(), { waitUntil: "load" });

if (opts.instrument) {
  // Go through the real control, not Tuner.setSetting — that skips syncControls() and leaves the
  // segmented button showing the previous instrument.
  await page.click(`#instrument button[data-value="${opts.instrument}"]`);
}
await page.click("#start");
await page.waitForTimeout(opts.settle);
if (opts.dev) await page.click(".dev-toggle");

const state = await page.evaluate(() => {
  const m = Tuner.engine.lastEstimate || {};
  return { string: m.s, cents: m.c, state: m.st, trailPoints: fig.count,
           build: document.getElementById("buildid").textContent };
});
await page.screenshot({ path: opts.out });
await browser.close();

console.log(`${opts.out}  ${opts.w}x${opts.h} ${opts.theme} ${opts.engine}  ${JSON.stringify(state)}`);
if (errors.length) { console.error("\n" + errors.join("\n")); process.exit(1); }
