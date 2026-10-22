/** What setting up voice on this Mac is doing, in order. */
export type VoiceEngineStep = "space" | "uv" | "python" | "packages" | "models";

export const voiceEngineStepLabels: Record<VoiceEngineStep, string> = {
  space: "Checking free space",
  uv: "Downloading uv",
  python: "Installing Python",
  packages: "Installing the speech servers",
  models: "Downloading the models",
};

/** Mirador's own speech engine on this Mac: Whisper and Kokoro, and Gemma as the voice model if the user wants it. */
export type VoiceEngineSetup =
  | { state: "unsupported"; reason: string }
  | { state: "not-set-up" }
  /** done and total count bytes while downloading; both 0 while a step can't tell how far it is. */
  | { state: "setting-up"; withVoiceModel: boolean; step: VoiceEngineStep; done: number; total: number }
  | { state: "failed"; withVoiceModel: boolean; problem: string }
  /** problem says why adding the voice model failed; what was set up before still works. */
  | { state: "set-up"; withVoiceModel: boolean; bytesOnDisk: number; problem?: string };

/** Each server's state, kept apart from setup: stopped servers load again the next time they're needed. */
export type EngineServer = "speech" | "voiceModel";
export type EngineServerState = "stopped" | "loading" | "ready";

export interface VoiceEngineStatus {
  setup: VoiceEngineSetup;
  servers: Record<EngineServer, EngineServerState>;
  /** About how much disk the engine takes: the speech servers with speech recognition and speech, and the voice model on top. */
  diskBytes: { base: number; voiceModel: number };
}

export const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
