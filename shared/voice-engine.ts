/** What setting up voice on this Mac is doing, in order. */
export type VoiceEngineStep = "space" | "uv" | "python" | "packages" | "models";

export const voiceEngineStepLabels: Record<VoiceEngineStep, string> = {
  space: "Checking free space",
  uv: "Downloading uv",
  python: "Installing Python",
  packages: "Installing the speech servers",
  models: "Downloading the models",
};

/** Mirador's own speech engine on this Mac: speech recognition and Kokoro, and a voice model if the user wants one. */
export type VoiceEngineSetup =
  | { state: "unsupported"; reason: string }
  | { state: "not-set-up" }
  /** done and total count bytes while downloading; both 0 while a step can't tell how far it is. */
  | { state: "setting-up"; step: VoiceEngineStep; done: number; total: number }
  | { state: "failed"; problem: string }
  /** problem says why adding models failed; what was set up before still works. */
  | { state: "set-up"; bytesOnDisk: number; problem?: string };

/** Each server's state, kept apart from setup: stopped servers load again the next time they're needed. */
export type EngineServer = "speech" | "voiceModel" | "speaking";
export type EngineServerState = "stopped" | "loading" | "ready";

export interface VoiceEngineStatus {
  setup: VoiceEngineSetup;
  servers: Record<EngineServer, EngineServerState>;
  /** The models the servers may use, by id, kept while setup adds others. */
  onDisk: string[];
  /** This Mac's, which tells the models that fit it. */
  memoryBytes: number;
}

export const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
