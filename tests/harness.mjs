// Headless driver for tuner-worklet.js.
//
// The worklet is loaded UNDER `vm` with the AudioWorkletGlobalScope pieces stubbed
// (AudioWorkletProcessor, registerProcessor, sampleRate, currentTime) and the registered class
// captured. That keeps the DSP as ONE source of truth: these tests run the file that ships, not a
// port of it. No build step, no duplicated math.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const WORKLET = new URL("../tuner-worklet.js", import.meta.url);
const STRINGS = new URL("../strings.js", import.meta.url);

export const QUANTUM = 128;

// strings.js is a plain browser script (assigns to a global), so evaluate it the same way.
export function loadStrings() {
  const ctx = vm.createContext({ Math, Array, Error });
  vm.runInContext(readFileSync(STRINGS, "utf8"), ctx);
  return ctx.Strings;
}

export function loadProcessor(rate) {
  let Registered = null;
  const ctx = {
    sampleRate: rate,
    currentTime: 0,
    AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage() {}, onmessage: null }; }
    },
    registerProcessor: (_name, cls) => { Registered = cls; },
    Math, Object, Array, Float32Array, Float64Array, Error, console,
    isFinite, isNaN, Number,
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(WORKLET, "utf8"), ctx);
  if (!Registered) throw new Error("tuner-worklet.js did not call registerProcessor");
  return Registered;
}

// A running tuner you can push signal into. `messages` accumulates exactly what the main thread
// would receive, which is what the assertions below are written against (ADDENDUM section 1).
export function makeTuner({ rate = 48000, targets, ratios, config = {} } = {}) {
  const P = loadProcessor(rate);
  const proc = new P({ processorOptions: { targets, ratios, config } });
  const messages = [];
  proc.port.postMessage = (m) => messages.push(m);
  return {
    proc, messages, rate,
    // Deliver a control message exactly as tuner.js does — through the port, not by calling the
    // handler — so a test covers the real boundary rather than an internal method name.
    send(msg) { proc.port.onmessage({ data: msg }); return this; },
    // Feed a Float32Array as consecutive 128-sample render quanta.
    feed(signal) {
      const q = new Float32Array(QUANTUM);
      for (let off = 0; off + QUANTUM <= signal.length; off += QUANTUM) {
        q.set(signal.subarray(off, off + QUANTUM));
        proc.process([[q]], [[new Float32Array(QUANTUM)]], {});
      }
      return this;
    },
    last() { return messages[messages.length - 1]; },
    // The settled reading: messages from the tail, after transients and a full LSQ window.
    settled(fraction = 0.25) {
      const n = Math.max(1, Math.floor(messages.length * fraction));
      return messages.slice(messages.length - n);
    },
  };
}

// ---- signal generation ------------------------------------------------------

export const centsToRatio = (c) => Math.pow(2, c / 1200);

// A bowed string is not a sine. `partials: n` sums n harmonics at 1/k amplitude, which is a crude
// but honest stand-in — enough to exercise the detector's partial-series confusion cases.
//
// `amps: [...]` overrides the profile entirely, one amplitude per harmonic starting at the
// fundamental. That is what models the case this app actually got wrong on a real instrument: a
// violin G string whose FUNDAMENTAL is far weaker than its upper partials, because the body barely
// radiates 196 Hz and a phone mic rolls off below it.
export function tone(freq, seconds, rate, { amp = 0.3, partials = 1, phase = 0, decay = 1, amps = null } = {}) {
  const n = Math.floor(seconds * rate);
  const out = new Float32Array(n);
  const count = amps ? amps.length : partials;
  for (let k = 1; k <= count; k++) {
    const a = amps ? amps[k - 1] : amp / Math.pow(k, decay);
    if (!a) continue;
    const w = (2 * Math.PI * freq * k) / rate;
    for (let i = 0; i < n; i++) out[i] += a * Math.sin(w * i + phase * k);
  }
  return out;
}

export function silence(seconds, rate) {
  return new Float32Array(Math.floor(seconds * rate));
}

export function concat(...parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Δf implied by a cents error, and its inverse — the sanity anchor the whole app rests on:
// 1 revolution per second at A440 is exactly 3.93 cents.
export const centsToHz = (cents, f0) => f0 * (centsToRatio(cents) - 1);
export const hzToCents = (df, f0) => 1200 * Math.log2(1 + df / f0);
