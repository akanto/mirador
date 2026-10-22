import { expect, test } from "bun:test";
import type { VoiceEngineSetup } from "../shared/voice-engine.ts";
import { VoiceEngine } from "../host/voice/engine/engine.ts";
import { VoiceUnavailable } from "../host/voice/voice.ts";

test("no server starts while voice is being removed from this Mac", async () => {
  const deleted = Promise.withResolvers<void>();
  const started: string[] = [];
  const setup: VoiceEngineSetup = { state: "set-up", withVoiceModel: true, bytesOnDisk: 1 };
  const engine = new VoiceEngine(
    { status: () => ({ setup, diskBytes: { base: 0, voiceModel: 0 } }), setUp: () => {}, cancel: () => {}, remove: () => deleted.promise },
    {
      states: () => ({ speech: "stopped", voiceModel: "stopped" }),
      use: async (service, work) => {
        started.push(service);
        return work({ url: "http://127.0.0.1:1/v1", apiKey: "", model: service });
      },
      stopAll: async () => {},
      killAllNow: () => {},
      idleTimeChanged: () => {},
    },
  );
  const removed = engine.remove();
  await expect(engine.use("recognition", async () => "heard")).rejects.toThrow(new VoiceUnavailable("Voice is being removed from this Mac."));
  deleted.resolve();
  await removed;
  expect(await engine.use("recognition", async () => "heard")).toBe("heard");
  expect(started).toEqual(["recognition"]);
});
