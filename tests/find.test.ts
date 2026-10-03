import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ConversationEvent, StoredEvent } from "../shared/model.ts";
import { matchOffsets, occurrencesIn } from "../shared/find.ts";
import { buildTimeline } from "../shared/timeline.ts";

function stored(events: ConversationEvent[]): StoredEvent[] {
  return events.map((event, index) => ({ seq: index + 1, at: (index + 1) * 1000, event }));
}

const acp = (update: SessionUpdate): ConversationEvent => ({ type: "acp", update });

describe("matchOffsets", () => {
  test("finds every occurrence, ignoring case", () => {
    expect(matchOffsets("Needle, needle, NEEDLE", "needle")).toEqual([
      [0, 6],
      [8, 14],
      [16, 22],
    ]);
  });

  test("takes the query literally", () => {
    expect(matchOffsets("a.b axb (c)", "a.b")).toEqual([[0, 3]]);
    expect(matchOffsets("a.b axb (c)", "(c)")).toEqual([[8, 11]]);
  });

  test("finds nothing for an empty query", () => {
    expect(matchOffsets("anything", "")).toEqual([]);
  });
});

describe("occurrencesIn", () => {
  test("counts what a folded tool card holds: its output, its input and what its subagent did", () => {
    const [card] = buildTimeline(
      stored([
        acp({
          sessionUpdate: "tool_call",
          toolCallId: "toolu_task",
          title: "Task",
          kind: "think",
          status: "completed",
          rawInput: { description: "Find the needle" },
          content: [{ type: "content", content: { type: "text", text: "The needle is in the haystack." } }],
          _meta: { claudeCode: { toolName: "Agent" } },
        }),
        acp({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Looking for a needle." },
          _meta: { claudeCode: { parentToolUseId: "toolu_task" } },
        }),
      ]),
    );
    expect(occurrencesIn(card!, "needle")).toBe(3);
  });

  test("counts a message by its markdown source", () => {
    const [message] = buildTimeline(stored([acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A **needle** and a needle" } })]));
    expect(occurrencesIn(message!, "needle")).toBe(2);
  });
});
