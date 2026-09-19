#!/usr/bin/env node
"use strict";

const assert = require("assert");
const path = require("path");
const AutoScrub = require(path.join(__dirname, "..", "classifier.js"));

const SR = 44100;
const FFT = 2048;
const DT = 40;

function frameAt(gen, t0) {
  const time = new Float32Array(FFT);
  for (let i = 0; i < FFT; i++) time[i] = gen((t0 + i) / SR);
  const spec = AutoScrub.magnitudeSpectrum(time, FFT);
  const feat = AutoScrub.extractFeatures(time, spec, SR, FFT);
  feat.spectrum = spec;
  return feat;
}

function run(gen, seconds, opts) {
  const c = new AutoScrub.Classifier(opts);
  let t = 0;
  let last = null;
  const frames = Math.ceil((seconds * 1000) / DT);
  for (let i = 0; i < frames; i++) {
    last = c.update(frameAt(gen, t * SR), DT, 1);
    t += DT / 1000;
  }
  return last;
}

function speechLike(t) {
  const gate = t % 0.26 < 0.17 ? 1 : 0.04;
  const am = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
  const noise = Math.sin(2 * Math.PI * 190 * t) * 0.25
    + Math.sin(2 * Math.PI * 820 * t) * 0.55
    + Math.sin(2 * Math.PI * 1450 * t) * 0.35
    + Math.sin(2 * Math.PI * 2400 * t) * 0.2
    + (hashNoise(t) * 0.35);
  return noise * am * gate * 0.45;
}

function musicLike(t) {
  const chord =
    0.35 * Math.sin(2 * Math.PI * 110 * t) +
    0.28 * Math.sin(2 * Math.PI * 220 * t) +
    0.22 * Math.sin(2 * Math.PI * 330 * t) +
    0.18 * Math.sin(2 * Math.PI * 440 * t) +
    0.12 * Math.sin(2 * Math.PI * 554 * t);
  const beat = t % 0.5;
  const kick = beat < 0.05 ? Math.sin(2 * Math.PI * 55 * t) * (1 - beat / 0.05) * 1.4 : 0;
  const hat = Math.abs(beat - 0.25) < 0.012 ? hashNoise(t) * 0.4 : 0;
  return (chord + kick + hat) * 0.4;
}

function silenceLike() {
  return 0;
}

function hashNoise(t) {
  const x = Math.sin(t * 12591.13) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function mix(t) {
  return speechLike(t) * 0.45 + musicLike(t) * 0.8;
}

const speech = run(speechLike, 2.8);
assert.equal(speech.mode, "speech", `speech classified as ${speech.mode} (s=${speech.speech.toFixed(2)} m=${speech.music.toFixed(2)})`);

const music = run(musicLike, 2.8);
assert.equal(music.mode, "music", `music classified as ${music.mode} (s=${music.speech.toFixed(2)} m=${music.music.toFixed(2)})`);

const quiet = run(silenceLike, 2.0);
assert.equal(quiet.mode, "silence", `silence classified as ${quiet.mode}`);

const both = run(mix, 2.8);
assert.equal(both.mode, "music", `music+talk should stay at music, got ${both.mode} (s=${both.speech.toFixed(2)} m=${both.music.toFixed(2)})`);

const sineFeat = frameAt((t) => Math.sin(2 * Math.PI * 440 * t) * 0.5, 0);
assert.ok(sineFeat.rms > 0.2 && sineFeat.rms < 0.5, `sine rms ${sineFeat.rms}`);
assert.ok(sineFeat.flatness < 0.35, `sine should be tonal, flatness=${sineFeat.flatness}`);

console.log("ok");
console.log("  speech", { mode: speech.mode, s: speech.speech.toFixed(2), m: speech.music.toFixed(2) });
console.log("  music ", { mode: music.mode, s: music.speech.toFixed(2), m: music.music.toFixed(2) });
console.log("  mix   ", { mode: both.mode, s: both.speech.toFixed(2), m: both.music.toFixed(2) });
console.log("  quiet ", quiet.mode);
