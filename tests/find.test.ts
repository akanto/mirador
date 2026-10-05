import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ConversationEvent, StoredEvent } from "../shared/model.ts";
import { matchCount, matchOffsets, occurrencesIn, textsOf } from "../shared/find.ts";
import { snippetAround } from "../host/search.ts";
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

describe("matchCount", () => {
  test("counts what matchOffsets finds, also a letter that occurs a million times", () => {
    expect(matchCount("Needle, needle, NEEDLE", "needle")).toBe(3);
    expect(matchCount("a.b axb (c)", "a.b")).toBe(1);
    expect(matchCount("anything", "")).toBe(0);
    expect(matchCount("e".repeat(1_000_000), "E")).toBe(1_000_000);
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

describe("textsOf", () => {
  test("holds a tool call's input as its words, so a search snippet shows no JSON keys or quotes", () => {
    const [card] = buildTimeline(
      stored([
        acp({
          sessionUpdate: "tool_call",
          toolCallId: "t",
          title: "Task",
          kind: "think",
          status: "completed",
          rawInput: { description: "Find where the test presses Enter", prompt: "line one\nline two", limit: 20 },
        }),
      ]),
    );
    const text = textsOf(card!).join("\n");
    expect(snippetAround(text, matchOffsets(text, "presses Enter")[0]!)).toEqual({ before: "Find where the test ", match: "presses Enter", after: "" });
    expect(matchOffsets(text, "description")).toEqual([]);
    expect(matchCount(text, "20")).toBe(1);
  });
});
