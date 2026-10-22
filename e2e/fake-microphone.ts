import { createHash } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SPEECH_SECONDS = 2;
export const SILENCE_SECONDS = 4;

/** Speech-like bursts, then silence: Chrome's fake microphone plays it from the start each time it opens, then over again. */
function microphoneSound() {
  const rate = 48_000;
  const samples = Array.from({ length: (SPEECH_SECONDS + SILENCE_SECONDS) * rate }, (_, index) => {
    const seconds = index / rate;
    if (seconds >= SPEECH_SECONDS) return 0;
    const syllables = Math.sqrt(Math.max(0, Math.sin(2 * Math.PI * 4 * seconds)));
    const pitch = 140 + 30 * Math.sin(2 * Math.PI * 1.3 * seconds);
    const harmonics = Array.from({ length: 12 }, (_, overtone) => Math.sin(2 * Math.PI * pitch * (overtone + 1) * seconds) / (overtone + 1));
    return 0.25 * syllables * harmonics.reduce((sum, harmonic) => sum + harmonic, 0);
  });
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples.length * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + index * 2));
  return wav;
}

/** Each Playwright process loads the spec, and runs of other checkouts may too, so the file is put in place whole, named by its sound. */
const sound = microphoneSound();
const microphoneFile = join(tmpdir(), `mirador-e2e-dictation-microphone-${createHash("sha256").update(sound).digest("hex").slice(0, 12)}.wav`);
if (!existsSync(microphoneFile)) {
  const partial = `${microphoneFile}.${process.pid}`;
  writeFileSync(partial, sound);
  renameSync(partial, microphoneFile);
}

/** For test.use: Chrome's fake microphone plays the sound, and its question is answered as allowed. */
export const fakeMicrophone = {
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${microphoneFile}`] },
  permissions: ["microphone"],
};
