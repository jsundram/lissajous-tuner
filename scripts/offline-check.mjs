#!/usr/bin/env node
// Verify the deployed app survives offline — the check that is easy to skip and expensive to get
// wrong, because a missing precache entry breaks the app in a way that looks like a DSP bug.
// Loads once online to prime the service worker, kills the network, reloads, and confirms the app
// still boots AND that the worklet (fetched by addModule long after boot) still loads.
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "https://jsundram.github.io/lissajous-tuner/";
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// 1. online: prime the cache
await page.goto(BASE, { waitUntil: "load" });
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 })
  .catch(() => {});
// The SW precaches on install; give it a moment to finish writing the shell.
await page.waitForTimeout(3000);
const primed = await page.evaluate(async () => {
  const keys = await caches.keys();
  const k = keys.find((x) => x.startsWith("lt-v"));
  const n = k ? (await (await caches.open(k)).keys()).length : 0;
  return { keys, entries: n, controller: !!navigator.serviceWorker.controller };
});

// 2. offline: reload and confirm it still works
await ctx.setOffline(true);
await page.reload({ waitUntil: "load" });
const offline = await page.evaluate(async () => {
  // Can the worklet still be fetched? This is the precache entry that would otherwise be missed.
  let workletOk = false;
  try { workletOk = (await fetch("./tuner-worklet.js")).ok; } catch (e) { workletOk = false; }
  return {
    title: document.title,
    hasCanvas: !!document.getElementById("figure"),
    buildId: document.getElementById("buildid").textContent,
    chips: document.getElementById("chips").children.length,
    startVisible: !document.getElementById("overlay").hidden,
    workletFetchable: workletOk,
    globals: { Strings: typeof Strings, Tuner: typeof Tuner, Theme: typeof Theme },
  };
});

// 3. and does it actually RUN offline? ?test=1 needs no mic.
await page.goto(BASE + "?test=1&cents=3.93", { waitUntil: "load" });
await page.click("#start");
await page.waitForTimeout(2500);
const running = await page.evaluate(() => {
  const m = Tuner.engine.lastEstimate;
  return m ? { state: m.st, cents: m.c, string: m.s } : null;
});

await ctx.setOffline(false);
await browser.close();

console.log(JSON.stringify({ primed, offline, runningOffline: running }, null, 2));
const fail = [];
if (!primed.entries) fail.push("nothing precached");
if (!offline.hasCanvas) fail.push("app did not boot offline");
if (!offline.workletFetchable) fail.push("tuner-worklet.js NOT available offline (missing from SHELL)");
if (offline.globals.Tuner !== "object") fail.push("tuner.js did not load offline");
if (!running || running.state !== 1) fail.push("tuner did not reach a locked state offline");
if (errors.length) fail.push("page errors: " + errors.join(" | "));
if (fail.length) { console.error("\nFAILED:\n- " + fail.join("\n- ")); process.exit(1); }
console.log("\noffline check passed");
