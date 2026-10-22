import { inDesktopApp } from "./desktop-bridge.ts";
import { wavOf } from "./wav.ts";

const SPEECH_SAMPLE_RATE = 16_000;
const LEVEL_EVERY_MS = 100;

export class MicrophoneProblem extends Error {}

export interface Recording {
  /** Ends the recording, giving what was said as 16 kHz mono WAV. */
  finish(): Promise<Blob>;
  cancel(): void;
}

function microphoneUnreachable() {
  if (inDesktopApp()) return "The desktop app can't use the microphone yet. Mirador in a browser can.";
  if (!window.isSecureContext) return "The browser lets pages use the microphone only over https or at localhost. Open Mirador at one of those to dictate.";
  return "This browser doesn't let pages use the microphone.";
}

async function microphone() {
  if (!navigator.mediaDevices?.getUserMedia) throw new MicrophoneProblem(microphoneUnreachable());
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" && inDesktopApp()) throw new MicrophoneProblem(microphoneUnreachable());
    if (name === "NotAllowedError") throw new MicrophoneProblem("Mirador may not use the microphone. The browser's settings for this site can allow it.");
    if (name === "NotFoundError") throw new MicrophoneProblem("There is no microphone to listen with.");
    throw new MicrophoneProblem(`The microphone didn't start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const rootMeanSquare = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);

function mixedToMono(audio: AudioBuffer) {
  const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel));
  return channels.length === 1 ? channels[0]! : channels[0]!.map((_, index) => channels.reduce((sum, channel) => sum + channel[index]!, 0) / channels.length);
}

/** Decoding into a 16 kHz context resamples too. */
async function asSpeechClip(recorded: Blob) {
  const decoded = await new OfflineAudioContext(1, 1, SPEECH_SAMPLE_RATE).decodeAudioData(await recorded.arrayBuffer());
  return new Blob([wavOf(mixedToMono(decoded), SPEECH_SAMPLE_RATE)], { type: "audio/wav" });
}

/**
 * Starts listening, telling the microphone's level as it goes. Call it from the press itself: its audio context is made
 * before the first await, while the browser still counts the press as the user's, or it may stay suspended.
 */
export async function startRecording(onLevel: (level: number) => void): Promise<Recording> {
  const levels = new AudioContext();
  void levels.resume();
  let stream: MediaStream;
  try {
    stream = await microphone();
  } catch (error) {
    void levels.close();
    throw error;
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
  const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
  recorder.start();
  const analyser = levels.createAnalyser();
  levels.createMediaStreamSource(stream).connect(analyser);
  const latestSamples = new Float32Array(analyser.fftSize);
  const tellLevel = setInterval(() => {
    analyser.getFloatTimeDomainData(latestSamples);
    onLevel(rootMeanSquare(latestSamples));
  }, LEVEL_EVERY_MS);
  const stopRecorder = () => recorder.state !== "inactive" && recorder.stop();
  const release = () => {
    clearInterval(tellLevel);
    stream.getTracks().forEach((track) => track.stop());
    void levels.close();
  };
  return {
    async finish() {
      stopRecorder();
      await stopped;
      release();
      return asSpeechClip(new Blob(chunks, { type: recorder.mimeType }));
    },
    cancel() {
      stopRecorder();
      release();
    },
  };
}
