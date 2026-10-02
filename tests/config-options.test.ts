import { expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { knownModes } from "../shared/config-options.ts";
import type { Conversation, HarnessId } from "../shared/model.ts";

const modeOption = (values: string[]): SessionConfigOption => ({
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue: values[0]!,
  options: values.map((value) => ({ value, name: value })),
});

const conversation = (harness: HarnessId, updatedAt: number, configOptions: SessionConfigOption[]) => ({ harness, updatedAt, configOptions }) as Conversation;

test("an agent's modes are the ones its most recently active conversation lists, and none before one has run", () => {
  const conversations = [
    conversation("claude", 1, [modeOption(["default", "plan"])]),
    conversation("claude", 3, [modeOption(["default", "acceptEdits", "plan"])]),
    conversation("claude", 5, []),
    conversation("opencode", 9, [modeOption(["build", "plan"])]),
  ];
  expect(knownModes(conversations, "claude").map(({ value }) => value)).toEqual(["default", "acceptEdits", "plan"]);
  expect(knownModes(conversations.slice(0, 3), "opencode")).toEqual([]);
});
