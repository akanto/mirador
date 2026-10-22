import { expect, test } from "bun:test";
import type { VoiceEngineSetup } from "../shared/voice-engine.ts";
import { VoiceEngine } from "../host/voice/engine/engine.ts";
import { VoiceUnavailable } from "../host/voice/voice.ts";

const setup: VoiceEngineSetup = { state: "set-up", bytesOnDisk: 1 };

function engineWith({ remove = async () => {}, removeModel = async () => {}, served = [] as string[] }) {
  const started: string[] = [];
  const stopped: string[] = [];
  const engine = new VoiceEngine(
    { status: () => ({ setup, onDisk: [], memoryBytes: 0 }), setUp: () => {}, cancel: () => {}, remove, removeModel },
    {
      states: () => ({ speech: "stopped", voiceModel: "stopped", speaking: "stopped" }),
      use: async (_, model, work) => {
        started.push(model);
        return work({ url: "http://127.0.0.1:1/v1", apiKey: "", model });
      },
      servedModels: () => served,
      stopServing: async (model) => {
        stopped.push(model);
      },
      stopAll: async () => {},
      killAllNow: () => {},
      idleTimeChanged: () => {},
    },
  );
  return { engine, started, stopped };
}

test("no server starts while voice is being removed from this Mac", async () => {
  const deleted = Promise.withResolvers<void>();
  const { engine, started } = engineWith({ remove: () => deleted.promise });
  const removed = engine.remove();
  await expect(engine.use("recognition", "whisper-large-v3-turbo", async () => "heard")).rejects.toThrow(new VoiceUnavailable("Voice is being removed from this Mac."));
  deleted.resolve();
  await removed;
  expect(await engine.use("recognition", "whisper-large-v3-turbo", async () => "heard")).toBe("heard");
  expect(started).toEqual(["whisper-large-v3-turbo"]);
});

test("a model being removed stops its server first and doesn't start again, while the others go on", async () => {
  const deleted = Promise.withResolvers<void>();
  const { engine, started, stopped } = engineWith({ removeModel: () => deleted.promise });
  const removed = engine.removeModel("gemma-4-12b");
  expect(stopped).toEqual(["gemma-4-12b"]);
  await expect(engine.use("voiceModel", "gemma-4-12b", async () => "translated")).rejects.toThrow(new VoiceUnavailable("Gemma 4 12B is being removed from this Mac."));
  expect(await engine.use("voiceModel", "gemma-4-e4b", async () => "translated")).toBe("translated");
  deleted.resolve();
  await removed;
  expect(started).toEqual(["gemma-4-e4b"]);
});

test("models the settings no longer use unload", async () => {
  const { engine, stopped } = engineWith({ served: ["whisper-large-v3-turbo", "gemma-4-26b-a4b"] });
  await engine.unloadAllBut(["whisper-large-v3-turbo", "gemma-4-12b"]);
  expect(stopped).toEqual(["gemma-4-26b-a4b"]);
});
