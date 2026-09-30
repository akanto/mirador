import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ConversationEvent, StoredEvent } from "../shared/model.ts";
import { lineDiff } from "../web/diff.ts";
import { buildTimeline } from "../web/timeline.ts";

function stored(events: ConversationEvent[]): StoredEvent[] {
  return events.map((event, index) => ({ seq: index + 1, at: (index + 1) * 1000, event }));
}

const acp = (update: SessionUpdate): ConversationEvent => ({ type: "acp", update });
const agentText = (text: string, meta?: Record<string, unknown>) =>
  acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, _meta: meta });

describe("buildTimeline", () => {
  test("merges consecutive agent chunks into one message", () => {
    const timeline = buildTimeline(stored([{ type: "user-message", text: "hi" }, agentText("Hel"), agentText("lo")]));
    expect(timeline.map((block) => [block.kind, "text" in block ? block.text : ""])).toEqual([
      ["user", "hi"],
      ["agent", "Hello"],
    ]);
  });

  test("keeps hook notices out of the agent's reply", () => {
    const timeline = buildTimeline(stored([agentText("DONE"), agentText("**Notice:** Stop says", { claudeCode: { kind: "informational" } })]));
    expect(timeline.map(({ kind }) => kind)).toEqual(["agent", "info"]);
  });

  test("folds tool call updates into the original card", () => {
    const timeline = buildTimeline(
      stored([
        acp({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "pending" }),
        acp({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "ok" }),
      ]),
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "tool", title: "Read", status: "completed", rawOutput: "ok" });
  });

  test("marks a permission as resolved with the chosen option", () => {
    const timeline = buildTimeline(
      stored([
        { type: "permission", permissionId: "p1", toolCall: { toolCallId: "t1" }, options: [{ optionId: "allow", name: "Yes", kind: "allow_once" }] },
        { type: "permission-resolved", permissionId: "p1", optionId: "allow" },
      ]),
    );
    expect(timeline[0]).toMatchObject({ kind: "permission", resolved: true, chosenOptionId: "allow" });
  });

  test("updates one plan per turn in place", () => {
    const entry = (status: "pending" | "completed") => ({ content: "step", priority: "medium" as const, status });
    const timeline = buildTimeline(
      stored([acp({ sessionUpdate: "plan", entries: [entry("pending")] }), acp({ sessionUpdate: "plan", entries: [entry("completed")] })]),
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "plan", entries: [{ status: "completed" }] });
  });

  test("shows abnormal turn endings only", () => {
    const timeline = buildTimeline(stored([{ type: "turn-end", stopReason: "end_turn" }, { type: "turn-end", stopReason: "cancelled" }]));
    expect(timeline).toEqual([{ kind: "notice", key: "2", at: 2000, text: "Turn ended: cancelled" }]);
  });

  test("a message made of many chunks has the time of its first chunk", () => {
    const timeline = buildTimeline(stored([{ type: "user-message", text: "hi" }, agentText("Hel"), agentText("lo")]));
    expect(timeline.map(({ at }) => at)).toEqual([1000, 2000]);
  });
});

describe("lineDiff", () => {
  test("marks added and removed lines around common ones", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
    ]);
  });

  test("treats a new file as all additions", () => {
    expect(lineDiff(null, "a\nb").map(({ kind }) => kind)).toEqual(["added", "added"]);
  });
});
