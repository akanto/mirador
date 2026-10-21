import { join } from "node:path";

export type EngineModelId = "recognition" | "speech" | "voiceModel";

export interface EngineModel {
  repo: string;
  revision: string;
  /** What it downloads, as shown before setup starts. */
  bytes: number;
}

/** What setting up voice on this Mac installs, pinned so that every Mac gets the same engine. */
export interface EngineSources {
  uv: { url: string; sha256: string };
  pythonVersion: string;
  /** Compiled by scripts/lock-voice-engine.sh, with every package's hashes. */
  lockFile: string;
  /** Hugging Face, or a fake of it in e2e. */
  modelsUrl: string;
  models: Record<EngineModelId, EngineModel>;
}

export const engineSources = (modelsUrl: string): EngineSources => ({
  uv: {
    url: "https://github.com/astral-sh/uv/releases/download/0.13.4/uv-aarch64-apple-darwin.tar.gz",
    sha256: "e0b1d4743ce64c55d9f0f4a444afa6b81125680070ee04e853fcd0f6c1ebf8f1",
  },
  pythonVersion: "3.12.15",
  lockFile: join(import.meta.dir, "requirements.lock"),
  modelsUrl,
  models: {
    recognition: { repo: "mlx-community/whisper-large-v3-turbo-asr-fp16", revision: "624c19c9af5603fa73b83bce14d4aeea96156d18", bytes: 1_618_633_596 },
    speech: { repo: "mlx-community/Kokoro-82M-bf16", revision: "a71e4d38b236d968966a2002c4c895dbd12b1c3c", bytes: 383_587_492 },
    voiceModel: { repo: "mlx-community/gemma-4-26b-a4b-it-4bit", revision: "0d77464eeb233a2da68ebf9d7dc4edaac7db956d", bytes: 15_373_586_252 },
  },
});

/** Kokoro's sample recordings and the repositories' readmes; the servers never read them. */
export const isUnusedModelFile = (path: string) => path.endsWith(".md") || path === ".gitattributes" || path.startsWith("samples/");

/** mlx-audio tells a model's kind from its folder's name when its config doesn't say, as Kokoro's doesn't. */
export const modelFolderName = ({ repo }: EngineModel) => repo.split("/").at(-1)!;
