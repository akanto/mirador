import { describe, expect, test } from "bun:test";
import { bestFitting, choosableModels, memoryNeededGb, modelsFor } from "../shared/voice-engine-models.ts";
import { modelChoice, tooLittleMemoryForVoiceModel } from "../web/voice-models.ts";

const gigabytesOfMemory = (size: number) => size * 2 ** 30;

describe("the models of this Mac's engine", () => {
  test("a Mac gets the best voice model that holds at most half its memory, and an 8 GB Mac none", () => {
    const picked = [8, 16, 18, 24, 32, 36, 64].map((size) => [size, bestFitting("voiceModel", gigabytesOfMemory(size))?.name ?? null]);
    expect(Object.fromEntries(picked)).toEqual({
      8: null,
      16: "Gemma 4 E4B",
      18: "Gemma 4 12B",
      24: "Gemma 4 12B",
      32: "Gemma 4 26B-A4B",
      36: "Gemma 4 26B-A4B",
      64: "Gemma 4 26B-A4B",
    });
    expect(bestFitting("recognition", gigabytesOfMemory(8))?.name).toBe("Whisper large-v3 turbo");
  });

  test("each tells the least memory a Mac comes with that it fits", () => {
    expect(modelsFor("voiceModel").map((model) => [model.name, memoryNeededGb(model)])).toEqual([
      ["Gemma 4 26B-A4B", 32],
      ["Gemma 4 12B", 18],
      ["Gemma 4 E4B", 16],
    ]);
  });

  test("each has an id of its own and is pinned to a commit", () => {
    expect(new Set(choosableModels.map(({ id }) => id)).size).toBe(choosableModels.length);
    expect(choosableModels.every(({ revision }) => /^[0-9a-f]{40}$/.test(revision))).toBe(true);
  });

  test("a choice says how good it is and what it downloads, or how much memory a Mac needs for it", () => {
    const [best] = modelsFor("voiceModel");
    expect(modelChoice(best!, gigabytesOfMemory(64))).toBe("Gemma 4 26B-A4B · best · 15.4 GB");
    expect(modelChoice(best!, gigabytesOfMemory(16))).toBe("Gemma 4 26B-A4B · best · needs a Mac with 32 GB of memory");
    expect(modelChoice(modelsFor("recognition")[0]!, gigabytesOfMemory(8)), "a model not compared yet has no hint").toBe("Whisper large-v3 turbo · 1.6 GB");
    expect(tooLittleMemoryForVoiceModel(gigabytesOfMemory(8))).toBe(
      "This Mac's 8 GB of memory is too little for a voice model of its own. A profile's API or a server of your own can translate, set below.",
    );
  });
});
