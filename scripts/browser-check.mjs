#!/usr/bin/env node
// Dev-only smoke test in a REAL browser. The vm harness proves the DSP; this proves the parts vm
// cannot see: that addModule() accepts the worklet, that AudioWorkletNode constructs with our
// processorOptions, that the graph is actually pulled, and that the page boots with no console
// errors. Uses ?test=1 so no microphone is involved.
//
//   node scripts/browser-check.mjs [baseUrl]
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://127.0.0.1:8137/";
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });   // iPhone-ish

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(BASE + "?test=1&cents=3.93&dev=1", { waitUntil: "load" });
await page.click("#start");
// The dev panel must not be covering anything on load — open it explicitly and confirm it shows.
await page.click(".dev-toggle");

// Let it settle past the LSQ window, then sample the estimate stream for a full second.
await page.waitForTimeout(2500);
const result = await page.evaluate(async () => {
  const samples = [];
  const t0 = performance.now();
  await new Promise((res) => {
    const prev = Tuner.engine.onEstimate;
    Tuner.engine.onEstimate = (m) => {
      prev(m);
      samples.push({ t: performance.now(), th: m.th, c: m.c, st: m.st, s: m.s });
      if (performance.now() - t0 > 1000) { Tuner.engine.onEstimate = prev; res(); }
    };
  });
  // Revolutions per second, from the angle the render actually consumes.
  let acc = 0;
  for (let i = 1; i < samples.length; i++) {
    let d = samples[i].th - samples[i - 1].th;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    acc += d;
  }
  const secs = (samples[samples.length - 1].t - samples[0].t) / 1000;
  const cs = samples.map((x) => x.c).filter((c) => c !== null).sort((a, b) => a - b);
  return {
    sampleRate: Tuner.engine.ctx.sampleRate,
    messages: samples.length,
    revsPerSec: Math.abs(acc / (2 * Math.PI)) / secs,
    cents: cs.length ? cs[cs.length >> 1] : null,
    string: samples.at(-1).s,
    state: samples.at(-1).st,
    buildId: document.getElementById("buildid").textContent,
    stringName: document.getElementById("string-name").textContent,
    centsText: document.getElementById("cents").textContent,
    devPanel: !document.getElementById("dev").hidden,
    diagnosticsLines: (typeof diagnostics === "function") ? diagnostics().split("\n").length : 0,
  };
});

await page.screenshot({ path: process.env.SHOT || "/tmp/tuner.png" });
await browser.close();

console.log(JSON.stringify(result, null, 2));
if (errors.length) { console.error("\nERRORS:\n" + errors.join("\n")); process.exit(1); }

const fail = [];
if (Math.abs(result.revsPerSec - 1) > 0.05) fail.push(`figure turned ${result.revsPerSec.toFixed(4)} rev/s, want 1.000`);
if (result.cents === null || Math.abs(result.cents - 3.93) > 0.05) fail.push(`cents ${result.cents}, want 3.93`);
if (result.state !== 1) fail.push(`state ${result.state}, want 1 (locked)`);
if (!result.messages) fail.push("no estimates arrived — the graph is not being pulled");
if (fail.length) { console.error("\nFAILED:\n- " + fail.join("\n- ")); process.exit(1); }
console.log("\nbrowser check passed");
