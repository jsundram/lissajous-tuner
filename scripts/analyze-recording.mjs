#!/usr/bin/env node
// Run a REAL recording through the shipping DSP and print what it made of it, second by second.
//
// This exists because every fixture in tests/ is synthetic. Synthetic partial profiles found the
// open-G misdetection and the sticky lock, but they are guesses about what a violin sounds like
// through a phone; a 20-second recording of the actual instrument in the actual room is worth more
// than all of them, and it turns "the G string doesn't work" into a timeline you can point at.
//
//   # 1. Record. Anything ffmpeg can read: Voice Memos .m4a, .wav, even a screen recording's audio.
//   #    Bow each open string for ~4 s in order, low to high, with a clear gap between them.
//   # ...or use the dev panel's "Record 15 s", which writes a .f32 + .json pair straight out of the
//   #    app on the phone. Pass the .f32 here: the sidecar supplies the sample rate and instrument.
//   # 2. Analyze:
//   node scripts/analyze-recording.mjs tuner-2026-09-04T18-21-00.f32
//   node scripts/analyze-recording.mjs take1.m4a
//   node scripts/analyze-recording.mjs take1.m4a --instrument cello --expect C2,G2,D3,A3
//   node scripts/analyze-recording.mjs take1.m4a --track A4     # cross-check against the app
//   node scripts/analyze-recording.mjs take1.m4a --save tests/fixtures/violin-sweep
//
// --save writes the .f32 + .json pair the harness reads, so a recording that shows a failure can
// become a regression test in one more step.
//
// Nothing here re-implements any DSP: it feeds tuner-worklet.js itself, exactly as tests/ does.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { makeTuner, loadStrings } from "../tests/harness.mjs";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const arg = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
if (!file) {
  console.error("usage: node scripts/analyze-recording.mjs <audio file> [--instrument violin]"
    + " [--refA 440] [--temperament pure] [--rate 48000] [--expect G3,D4,A4,E5] [--save path]");
  process.exit(2);
}

// The app's own recorder emits raw mono float32 plus a JSON sidecar. Prefer the sidecar's values so
// a capture analyses exactly as it was taken — the sample rate in particular, since iOS can hand the
// app a 16 kHz mic path and re-reading it at 48000 would silently transpose the whole recording.
const isRaw = /\.f32$/i.test(file);
const sidecarPath = file.replace(/\.f32$/i, ".json");
let sidecar = isRaw && existsSync(sidecarPath)
  ? JSON.parse(readFileSync(sidecarPath, "utf8")) : null;
// The dev panel's Record button writes ONE .wav and puts the sidecar in a RIFF INFO comment, so a
// recording made on the phone needs no second file to be fully self-describing.
if (!sidecar) {
  try {
    const tag = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags=comment",
      "-of", "default=nw=1:nk=1", file], { encoding: "utf8" }).trim();
    if (tag.startsWith("{")) sidecar = JSON.parse(tag);
  } catch (e) { /* no ffprobe, no tag, or not JSON: fall back to the flags */ }
}
if (isRaw && !sidecar) {
  console.error(`note: no sidecar at ${basename(sidecarPath)} — assuming --rate/--instrument flags`);
}

const instrument = arg("instrument", (sidecar && sidecar.instrument) || "violin");
const refA = Number(arg("refA", (sidecar && sidecar.refA) || 440));
const temperament = arg("temperament", (sidecar && sidecar.temperament) || "pure");
// Decode at the phone's rate by default. If the failure you are chasing is rate-dependent, this is
// the knob: iOS can hand the app a 16 kHz mic path.
const rate = Number(arg("rate", (sidecar && sidecar.sampleRate) || 48000));
const savePath = arg("save", null);

// Only the handful worth flagging when a sidecar disagrees; tuner.js PARAMS is authoritative.
const DEFAULTS_HINT = {
  bwCoef: 0.06, lsqSec: 0.5, gateAmp: 0.0012, hystDb: 3, hystBlocks: 3,
  detHarmonics: 4, unattributedRms: 0.02, outOfRangeCents: 120, unlockSec: 0.25,
};

const S = loadStrings();
const names = S.INSTRUMENTS[instrument].names;
const targets = S.targets(instrument, refA, temperament);
const ratios = S.ratios(instrument);

// ffmpeg to mono float32 little-endian on stdout. maxBuffer because a minute at 48 kHz is 11 MB.
// A .f32 from the app's own recorder IS already that, so it skips ffmpeg entirely.
let raw;
if (isRaw) {
  raw = readFileSync(file);
} else try {
  raw = execFileSync("ffmpeg", [
    "-v", "error", "-i", file, "-map", "0:a:0",
    "-ac", "1", "-ar", String(rate), "-f", "f32le", "-",
  ], { maxBuffer: 1 << 30 });
} catch (e) {
  console.error("ffmpeg failed — is it installed, and does the file have an audio track?");
  console.error(String(e.stderr || e.message).trim().split("\n").slice(-3).join("\n"));
  process.exit(1);
}
const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
if (!pcm.length) { console.error("no audio decoded"); process.exit(1); }

let peak = 0, sum = 0;
for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; sum += pcm[i] * pcm[i]; }
const rms = Math.sqrt(sum / pcm.length);

console.log(`${basename(file)}  ${(pcm.length / rate).toFixed(1)} s at ${rate} Hz`
  + (sidecar ? `  (sidecar: locked ${sidecar.string || "—"} while recording)` : ""));
if (sidecar && sidecar.params) {
  // A capture taken under non-default parameters analyses here under the CURRENT defaults, which is
  // usually what you want but is not what the phone was doing. Say so rather than let it confuse.
  const changed = Object.keys(sidecar.params).filter((k) => {
    const d = DEFAULTS_HINT[k];
    return d !== undefined && sidecar.params[k] !== d;
  });
  if (changed.length) {
    console.log("  recorded with non-default params: "
      + changed.map((k) => k + "=" + sidecar.params[k]).join("  ")
      + "\n  (this analysis uses the CURRENT defaults, not those)");
  }
}
console.log(`peak ${peak.toFixed(3)}  rms ${rms.toFixed(4)}   ${instrument} ${temperament} A=${refA}`);
if (peak < 0.02) console.log("  ** very quiet: the gate may never open. Record closer or louder. **");
if (peak > 0.999) console.log("  ** clipped: clipping adds harmonics and will skew detection. **");
console.log();

// --- the independent cross-check -----------------------------------------------------
// A pitch tracker that shares NO machinery with the thing under test: a harmonic comb scanned over
// a wide range, with no demodulator, no lock, no hysteresis and no +-150 cent detection band. This
// is what settles "is that excursion the instrument or the estimator", and grading the estimator
// with itself cannot answer it. It resolved a real question once already: 40-90 cent swings during
// tuning turned out to be genuine peg movement, confirmed because a string tuned with the FINE
// TUNER only stayed inside +-17 cents on the same instrument in the same room.
//
// RANGE stays under 351 cents on purpose. The strings are pure fifths (702 cents apart), so a wider
// scan finds the NEIGHBOUR and reports a confident -702 — which is exactly what a first version of
// this did, on an E-string take where the A was ringing.
const TRACK_RANGE = 340, TRACK_STEP = 3, TRACK_K = 6, TRACK_N = 8192;
function trackCents(off, f0) {
  if (off + TRACK_N > pcm.length) return null;
  let energy = 0;
  for (let i = 0; i < TRACK_N; i++) energy += pcm[off + i] * pcm[off + i];
  if (Math.sqrt(energy / TRACK_N) < 0.01) return null;      // too quiet to claim a pitch
  const mag = (f) => {
    const c = 2 * Math.cos((2 * Math.PI * f) / rate);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < TRACK_N; i++) { const v = pcm[off + i] + c * s1 - s2; s2 = s1; s1 = v; }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
  };
  let best = -Infinity, bestC = 0;
  for (let c = -TRACK_RANGE; c <= TRACK_RANGE; c += TRACK_STEP) {
    const f = f0 * Math.pow(2, c / 1200);
    let sum = 0;
    for (let k = 1; k <= TRACK_K; k++) if (f * k < rate / 2) sum += mag(f * k) / k;
    if (sum > best) { best = sum; bestC = c; }
  }
  return bestC;
}

const trackArg = arg("track", null);
let trackIdx = -1;
if (trackArg !== null) {
  trackIdx = /^\d+$/.test(trackArg) ? Number(trackArg) : names.indexOf(trackArg);
  if (trackIdx < 0 || trackIdx >= names.length) {
    console.error(`--track: "${trackArg}" is not a string of this instrument (${names.join(", ")})`);
    process.exit(2);
  }
}

const T = makeTuner({ rate, targets, ratios }).feed(pcm);
const msgPerSec = rate / 128 / 4;
const STATES = ["gated", "locked", "searching", "out-of-range"];

// One row per 0.5 s. The detection column is what makes a failure legible: it is every candidate's
// score in dB relative to the winner, so a string that is sounding but losing shows as a number.
const BUCKET = 0.5;
const per = Math.max(1, Math.round(msgPerSec * BUCKET));
console.log("   time  lock   state         cents"
  + (trackIdx >= 0 ? "   indep(" + names[trackIdx] + ")" : "")
  + "   level    mic rms   detection scores (dB, 0 = winner)");
const heardOverall = {};
for (let i = 0; i + per <= T.messages.length; i += per) {
  const b = T.messages.slice(i, i + per);
  const votes = {}, sts = {};
  const cs = [];
  let lvl = 0, mic = 0, sc = null;
  for (const m of b) {
    votes[m.s] = (votes[m.s] || 0) + 1;
    sts[m.st] = (sts[m.st] || 0) + 1;
    if (m.c !== null) cs.push(m.c);
    lvl += m.a || 0;
    mic += m.n || 0;
    if (m.sc) sc = m.sc;
  }
  const lock = Number(Object.keys(votes).sort((x, y) => votes[y] - votes[x])[0]);
  const st = Number(Object.keys(sts).sort((x, y) => sts[y] - sts[x])[0]);
  cs.sort((a, c) => a - c);
  const cents = cs.length ? cs[cs.length >> 1] : null;
  if (st === 1) heardOverall[lock] = (heardOverall[lock] || 0) + 1;
  console.log(
    (i / msgPerSec).toFixed(1).padStart(7) + "  "
    + (lock >= 0 ? names[lock] : "—").padEnd(5) + "  "
    + STATES[st].padEnd(13)
    + (cents === null ? "    —" : (cents > 0 ? "+" : "") + cents.toFixed(1)).padStart(6)
    + (trackIdx < 0 ? "" : (() => {
        const ind = trackCents(Math.round((i / msgPerSec) * rate), targets[trackIdx]);
        return (ind === null ? "—" : (ind > 0 ? "+" : "") + ind).padStart(13);
      })())
    + "  " + (lvl / b.length).toExponential(1).padStart(8) + "  "
    + (mic / b.length).toFixed(4).padStart(8) + "   "
    + (sc ? sc.map((v, k) => names[k] + " " + v.toFixed(0)).join("  ") : ""));
}

console.log();
const expect = arg("expect", null);
if (expect) {
  // With --expect, say plainly whether every named string was ever found. That is the check that
  // matters: "did bowing this string ever produce a reading for it".
  const want = expect.split(",").map((s) => s.trim());
  let bad = 0;
  for (const w of want) {
    const i = names.indexOf(w);
    if (i < 0) { console.log(`  ${w}: not a string of this instrument`); bad++; continue; }
    const secs = ((heardOverall[i] || 0) * BUCKET).toFixed(1);
    const ok = (heardOverall[i] || 0) > 0;
    console.log(`  ${w}: ${ok ? "found, locked " + secs + " s" : "NEVER LOCKED"}`);
    if (!ok) bad++;
  }
  process.exitCode = bad ? 1 : 0;
} else {
  console.log("strings locked at some point: "
    + (Object.keys(heardOverall).map((i) => names[i]).join(", ") || "none"));
}

if (savePath) {
  writeFileSync(savePath + ".f32", Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  writeFileSync(savePath + ".json", JSON.stringify({
    source: basename(file), sampleRate: rate, samples: pcm.length,
    instrument, refA, temperament, peak, rms,
  }, null, 2) + "\n");
  console.log(`\nwrote ${savePath}.f32 (${(pcm.length * 4 / 1e6).toFixed(1)} MB) and ${savePath}.json`);
}
