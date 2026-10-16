import { expect, test } from "bun:test";
import { steerAnswered } from "../host/conversations.ts";
import type { ConversationEvent, StoredEvent } from "../shared/model.ts";

const takenInAt = Date.parse("2026-10-16T08:04:25.490Z");
const steer = (...texts: string[]) => ({ messages: texts.map((text, index) => ({ id: `m${index}`, text, imageIds: [] })), steeredAt: takenInAt - 90 });
const transcriptTakingIn = (text: string) =>
  JSON.stringify({ type: "user", timestamp: new Date(takenInAt).toISOString(), message: { role: "user", content: [{ type: "text", text }] } });
const thought = (at: number): StoredEvent => ({
  seq: at,
  at,
  event: { type: "acp", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me look." } } } as ConversationEvent,
});

test("a steered message the agent never took in is unanswered, even with the agent's output after the steer", () => {
  expect(steerAnswered("", [thought(takenInAt + 50)], steer("Also say which day it is"))).toBe(false);
});

test("a steered message the agent took in is answered once its output came after, though a stop cut off the reply's first block", () => {
  const transcript = transcriptTakingIn("Also say which day it is");
  expect(steerAnswered(transcript, [thought(takenInAt - 50)], steer("Also say which day it is"))).toBe(false);
  expect(steerAnswered(transcript, [thought(takenInAt - 50), thought(takenInAt + 300)], steer("Also say which day it is"))).toBe(true);
});

test("steered messages are found by the first with text, and with none they count as answered", () => {
  expect(steerAnswered("", [], steer(" "))).toBe(true);
  expect(steerAnswered("", [], steer("", "Also say which day it is"))).toBe(false);
});
