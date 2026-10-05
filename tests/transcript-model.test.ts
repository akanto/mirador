import { expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { lastAnsweringModel, modelChoiceFor } from "../host/transcript-model.ts";

const record = (fields: Record<string, unknown>) => JSON.stringify(fields);
const answer = (model: string, isSidechain = false) => record({ type: "assistant", isSidechain, message: { role: "assistant", model, content: [] } });

test("a transcript's model is the one that answered last in the main thread, not a subagent's or an API error's", () => {
  const transcript = [
    record({ type: "user", message: { role: "user", content: "hi" } }),
    answer("claude-sonnet-5-5"),
    answer("claude-haiku-4-5-20251001"),
    answer("claude-opus-5-5", true),
    answer("<synthetic>"),
    record({ type: "user", message: { role: "user", content: "again" } }),
    "",
  ].join("\n");
  expect(lastAnsweringModel(transcript)).toBe("claude-haiku-4-5-20251001");
  expect(lastAnsweringModel([record({ type: "user" }), answer("<synthetic>"), "{ not json"].join("\n"))).toBeNull();
});

const picker = (values: [string, string, string][]): SessionConfigOption[] => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "opus",
    options: values.map(([value, name, description]) => ({ value, name, description })),
  },
];

test("a transcript's model maps to the picker's choice for it, and to none the picker lacks", () => {
  const options = picker([
    ["default", "Default (recommended)", "Opus"],
    ["opus", "Opus 5.5", "Opus 5.5 · Best for everyday, complex tasks"],
    ["sonnet", "Sonnet 5.5", "Sonnet 5.5 · Efficient for routine tasks"],
    ["haiku", "Haiku 4.5", "Haiku 4.5 · Fastest for quick answers"],
  ]);
  expect(modelChoiceFor(options, "claude-haiku-4-5-20251001")).toBe("haiku");
  expect(modelChoiceFor(options, "claude-sonnet-5-5")).toBe("sonnet");
  expect(modelChoiceFor(options, "claude-opus-4-1-20250805")).toBeNull();
  expect(modelChoiceFor([], "claude-haiku-4-5-20251001")).toBeNull();
});
