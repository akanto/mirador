import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CROSSFADE_FRAMES, FRAME } from "../src/brand.ts";
import { STORYBOARD } from "../src/storyboard.ts";
import type { ClipInfo, NarrationLine } from "../src/timeline.ts";
import { placeScenes } from "../src/timeline.ts";

/**
 * A placeholder score, synthesised here so the trailer builds without a licensed track: a drone and quickening ticks
 * under the wall of text, a riser into a hit on the logo, then a warm I–V–vi–IV pad with a pluck and a soft pulse
 * under the features, resolving on the end card. It is timed by the storyboard, so the hits land on the scene changes.
 * Run with bun after encode and narrate: bun audio/compose.ts
 */
const RATE = 48_000;
const video = join(import.meta.dirname, "..");
const output = join(video, "public", "music", "score.wav");

function sceneStarts() {
  const clipNames = [...new Set(STORYBOARD.flatMap((scene) => (scene.kind === "clip" ? [scene.clip] : [])))];
  const clips = Object.fromEntries(clipNames.map((name) => [name, JSON.parse(readFileSync(join(video, "public", "clips", `${name}.json`), "utf8")) as ClipInfo]));
  const { lines } = JSON.parse(readFileSync(join(video, "public", "narration", "manifest.json"), "utf8")) as { lines: Record<string, NarrationLine> };
  const placed = placeScenes(STORYBOARD, clips, lines, FRAME.fps, CROSSFADE_FRAMES);
  const last = placed.at(-1)!;
  return { starts: Object.fromEntries(placed.map(({ scene, from }) => [scene.id, from / FRAME.fps])), seconds: (last.from + last.frames) / FRAME.fps };
}

function seededNoise(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}
const noise = seededNoise(1729);

const midi = (note: number) => 440 * 2 ** ((note - 69) / 12);

class Mix {
  readonly left: Float32Array;
  readonly right: Float32Array;
  constructor(seconds: number) {
    this.left = new Float32Array(Math.ceil(seconds * RATE));
    this.right = new Float32Array(Math.ceil(seconds * RATE));
  }
  /** Adds a sound at a second, panned from -1 (left) to 1 (right). */
  add(at: number, sound: Float32Array, gain: number, pan = 0) {
    const start = Math.round(at * RATE);
    const leftGain = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const rightGain = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    sound.forEach((sample, index) => {
      const at = start + index;
      if (at < 0 || at >= this.left.length) return;
      this.left[at]! += sample * leftGain;
      this.right[at]! += sample * rightGain;
    });
  }
}

function render(seconds: number, sample: (t: number) => number) {
  return Float32Array.from({ length: Math.ceil(seconds * RATE) }, (_, index) => sample(index / RATE));
}

function lowpass(sound: Float32Array, cutoff: (t: number) => number) {
  let first = 0;
  let second = 0;
  return sound.map((sample, index) => {
    const amount = 1 - Math.exp((-2 * Math.PI * cutoff(index / RATE)) / RATE);
    first += (sample - first) * amount;
    second += (first - second) * amount;
    return second;
  });
}

function highpass(sound: Float32Array, cutoff: number) {
  const low = lowpass(sound, () => cutoff);
  return sound.map((sample, index) => sample - low[index]!);
}

const envelope = (t: number, length: number, attack: number, release: number) => Math.min(1, t / attack) * Math.min(1, Math.max(0, (length - t) / release));

/** Detuned saws through a soft filter: the warm bed. */
function pad(notes: number[], seconds: number, detuneCents: number) {
  const voices = notes.flatMap((note) => [-detuneCents, 0, detuneCents].map((cents) => ({ frequency: midi(note) * 2 ** (cents / 1200), phase: Math.abs(noise()) })));
  const raw = render(seconds, (t) => {
    const saws = voices.reduce((sum, { frequency, phase }) => {
      const cycle = frequency * t + phase;
      return sum + 2 * (cycle - Math.floor(cycle + 0.5));
    }, 0);
    return (saws / voices.length) * envelope(t, seconds, 1.4, 1.8);
  });
  return lowpass(raw, (t) => 900 + 500 * Math.sin(t * 0.4));
}

/** A soft bell-like pluck. */
function pluck(note: number, seconds = 1.6) {
  const frequency = midi(note);
  return render(seconds, (t) => Math.sin(2 * Math.PI * frequency * t + 1.2 * Math.exp(-t * 9) * Math.sin(2 * Math.PI * frequency * 2 * t)) * Math.exp(-t * 3.2) * Math.min(1, t / 0.004));
}

function kick() {
  let phase = 0;
  return render(0.45, (t) => {
    phase += (2 * Math.PI * (48 + 80 * Math.exp(-t * 32))) / RATE;
    return Math.sin(phase) * Math.exp(-t * 7);
  });
}

function hat(decay = 70) {
  return highpass(render(0.12, (t) => noise() * Math.exp(-t * decay)), 7000);
}

function boom() {
  let phase = 0;
  const sub = render(3.2, (t) => {
    phase += (2 * Math.PI * (30 + 42 * Math.exp(-t * 5))) / RATE;
    return Math.sin(phase) * Math.exp(-t * 1.3);
  });
  const air = lowpass(render(1.6, (t) => noise() * Math.exp(-t * 3.5)), () => 1800);
  return sub.map((sample, index) => sample + 0.5 * (air[index] ?? 0));
}

/** Noise swelling up through a rising filter, into a hit. */
function riser(seconds: number) {
  const raw = render(seconds, (t) => noise() * (t / seconds) ** 2.2);
  return lowpass(raw, (t) => 250 * 30 ** (t / seconds));
}

/** A short swell of air into a scene change. */
function whoosh(seconds = 0.7) {
  const raw = render(seconds, (t) => noise() * Math.sin((Math.PI * t) / seconds) ** 2);
  return highpass(lowpass(raw, (t) => 600 + 5000 * (t / seconds)), 300);
}

/** Adds a ping-pong echo to the plucks, for space without a reverb. */
function echo(mix: Mix, beat: number) {
  const delay = Math.round(beat * 0.75 * RATE);
  for (let index = delay; index < mix.left.length; index++) {
    mix.left[index]! += mix.right[index - delay]! * 0.32;
    mix.right[index]! += mix.left[index - delay]! * 0.32;
  }
}

function writeWav(path: string, { left, right }: Mix) {
  const peak = [left, right].reduce((loudest, channel) => channel.reduce((most, sample) => Math.max(most, Math.abs(sample)), loudest), 0);
  const gain = 0.89 / peak;
  const data = Buffer.alloc(left.length * 4);
  left.forEach((sample, index) => {
    data.writeInt16LE(Math.round(Math.tanh(sample * gain * 1.1) * 32000), index * 4);
    data.writeInt16LE(Math.round(Math.tanh(right[index]! * gain * 1.1) * 32000), index * 4 + 2);
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.concat([header, data]));
}

function compose() {
  const { starts, seconds } = sceneStarts();
  const mix = new Mix(seconds);
  const plucks = new Mix(seconds);
  const logo = starts.logo!;
  const features = starts.show!;
  const ending = starts.end!;
  const beat = 60 / 96;
  const bar = beat * 4;

  mix.add(0, pad([38, 45, 50], logo + 0.5, 4), 0.5);
  let tick = 0.6;
  for (let gap = 0.5; tick < logo - 0.3; tick += gap, gap = Math.max(0.07, gap * 0.9)) mix.add(tick, hat(110), 0.12 + 0.1 * (tick / logo), tick % 2 < 1 ? -0.4 : 0.4);
  mix.add(logo - 2.6, riser(2.6), 0.5);
  mix.add(logo, boom(), 1);
  mix.add(logo, pad([50, 54, 57, 64, 69], features - logo + 1.2, 6), 0.55);
  [74, 81, 78, 86].forEach((note, index) => plucks.add(logo + 0.08 + index * 0.16, pluck(note, 2.4), 0.3, index % 2 ? 0.45 : -0.45));

  const progression = [
    { chord: [50, 54, 57, 62], bass: 38, arpeggio: [62, 69, 74, 66] },
    { chord: [49, 52, 57, 61], bass: 37, arpeggio: [61, 69, 73, 64] },
    { chord: [47, 50, 54, 59], bass: 35, arpeggio: [59, 66, 71, 62] },
    { chord: [43, 50, 55, 59], bass: 31, arpeggio: [59, 67, 71, 62] },
  ];
  const bars = Math.floor((ending - features) / bar);
  Array.from({ length: bars }, (_, index) => {
    const at = features + index * bar;
    const { chord, bass, arpeggio } = progression[Math.floor(index / 2) % progression.length]!;
    if (index % 2 === 0) {
      mix.add(at, pad(chord, Math.min(bar * 2, ending - at) + 1.2, 7), 0.42);
      mix.add(at, lowpass(render(Math.min(bar * 2, ending - at), (t) => Math.sin(2 * Math.PI * midi(bass) * t) * envelope(t, bar * 2, 0.05, 0.4)), () => 200), 0.5);
    }
    Array.from({ length: 8 }, (_, eighth) => plucks.add(at + eighth * (beat / 2), pluck(arpeggio[eighth % 4]! + (eighth >= 4 ? 12 : 0), 0.9), 0.1 + (eighth % 4 === 0 ? 0.04 : 0), eighth % 2 ? 0.35 : -0.35));
    if (index >= 2) [0, 2].forEach((step) => mix.add(at + step * beat, kick(), 0.55));
    if (index >= 4) Array.from({ length: 8 }, (_, eighth) => mix.add(at + eighth * (beat / 2), hat(eighth % 2 ? 90 : 60), eighth % 2 ? 0.07 : 0.045, eighth % 2 ? 0.3 : -0.3));
  });
  STORYBOARD.slice(2).forEach(({ id }) => mix.add(starts[id]! - 0.55, whoosh(0.7), 0.18));

  mix.add(ending - 1.6, riser(1.6), 0.25);
  mix.add(ending, boom(), 0.6);
  mix.add(ending, pad([50, 57, 62, 66, 69, 76], seconds - ending, 6), 0.55);
  [74, 78, 81, 86, 90].forEach((note, index) => plucks.add(ending + 0.9 + index * 0.2, pluck(note, 3), 0.22, index % 2 ? 0.4 : -0.4));

  echo(plucks, beat);
  plucks.left.forEach((sample, index) => {
    mix.left[index]! += sample;
    mix.right[index]! += plucks.right[index]!;
  });
  const fadeOut = Math.round(1.8 * RATE);
  for (let index = mix.left.length - fadeOut; index < mix.left.length; index++) {
    const gain = (mix.left.length - index) / fadeOut;
    mix.left[index]! *= gain;
    mix.right[index]! *= gain;
  }
  writeWav(output, mix);
  console.log(`${output}: ${seconds.toFixed(1)} s; logo at ${logo.toFixed(2)} s, features from ${features.toFixed(2)} s, end card at ${ending.toFixed(2)} s`);
}

if (import.meta.main) compose();
