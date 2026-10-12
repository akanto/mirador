import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ConversationEvent, StoredEvent } from "../shared/model.ts";
import { lineDiff } from "../web/diff.ts";
import { authorOf, buildTimeline, startsAuthorGroup, subagentEndedAt, subagentsIn, subagentState, type TimelineBlock } from "../shared/timeline.ts";

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

  test("says which agent a conversation moved to, along with the profile", () => {
    const notices = buildTimeline(stored([{ type: "profile-changed", profileName: "Work" }, { type: "profile-changed", profileName: "Radiance", agent: "opencode" }]));
    expect(notices.map((block) => block.kind === "notice" && block.text)).toEqual(["Now using the profile “Work”", "Now using opencode, with the profile “Radiance”"]);
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

const launch = (toolCallId: string, input: Record<string, unknown>) =>
  acp({ sessionUpdate: "tool_call", toolCallId, title: "Task", kind: "think", status: "pending", rawInput: input, _meta: { claudeCode: { toolName: "Agent" } } });
const finish = (toolCallId: string, status: "completed" | "failed" = "completed") => acp({ sessionUpdate: "tool_call_update", toolCallId, status });
const answeredAtOnce = (toolCallId: string) =>
  acp({ sessionUpdate: "tool_call_update", toolCallId, _meta: { claudeCode: { toolName: "Agent", toolResponse: { isAsync: true, status: "async_launched" } } } });
const byParent = (parent: string) => ({ claudeCode: { parentToolUseId: parent } });
const read = (toolCallId: string, parent: string) =>
  acp({ sessionUpdate: "tool_call", toolCallId, title: `Read ${toolCallId}.ts`, status: "pending", _meta: { claudeCode: { parentToolUseId: parent, toolName: "Read" } } });

describe("a gateway that repeats a streamed message whole, under its id", () => {
  const says = (text: string, messageId?: string) => acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId });
  const toolStarts = acp({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Task", status: "pending" });
  const toolEnds = acp({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
  const shape = (events: ConversationEvent[]) => buildTimeline(stored(events)).map((block) => `${block.kind}:${"text" in block ? block.text : ""}`);
  const streamed = ["Both ", "worktrees ", "are clean."].map((piece) => says(piece, "chatcmpl-A"));

  test("shows the message once, whether the repeat comes after tool calls or straight after it", () => {
    expect(shape([...streamed, toolStarts, toolEnds, says("Both worktrees are clean.", "chatcmpl-A")])).toEqual(["agent:Both worktrees are clean.", "tool:"]);
    expect(shape([...streamed, says("Both worktrees are clean.", "chatcmpl-A")])).toEqual(["agent:Both worktrees are clean."]);
  });

  test("keeps what the agent really says twice: another message, equal chunks, no id, or a message sent whole", () => {
    const done = (messageId: string) => ["Do", "ne", "."].map((piece) => says(piece, messageId));
    expect(shape([...done("m1"), toolStarts, ...done("m2")])).toEqual(["agent:Done.", "tool:", "agent:Done."]);
    expect(shape([says("ha", "m"), says("ha", "m")])).toEqual(["agent:haha"]);
    expect(shape([says("a", "m"), says("b", "m"), says("ab", "m2")])).toEqual(["agent:abab"]);
    expect(shape([says("Hi"), says("Hi"), says("HiHi")])).toEqual(["agent:HiHiHiHi"]);
  });
});

describe("an API error Claude Code also says as the agent's message", () => {
  const apiError = "API Error: 502 Bad Gateway. This is a server-side issue, usually temporary.";

  test("shows once, as the error, with what marks it", () => {
    const timeline = buildTimeline(stored([{ type: "user-message", text: "go" }, agentText(apiError), { type: "error", message: `Internal error: ${apiError}: {"errorKind":"server_error"}` }]));
    expect(timeline.map(({ kind }) => kind)).toEqual(["user", "error"]);
    const limit = "You've hit your session limit · resets 6:20pm (Europe/Budapest)";
    expect(buildTimeline(stored([agentText(limit), { type: "error", message: limit, usageLimit: { resetsAt: 1 } }]))).toEqual([expect.objectContaining({ kind: "error", usageLimit: true })]);
  });

  test("keeps a reply an unrelated error follows, even one the error happens to contain", () => {
    expect(buildTimeline(stored([agentText("All done."), { type: "error", message: "ACP connection closed" }])).map(({ kind }) => kind)).toEqual(["agent", "error"]);
    expect(buildTimeline(stored([agentText("Done."), { type: "error", message: "Done. Then the agent stopped" }])).map(({ kind }) => kind)).toEqual(["agent", "error"]);
  });
});

describe("subagents", () => {
  test("what a subagent does goes under the tool call that started it, its own subagents' work under theirs", () => {
    const timeline = buildTimeline(
      stored([
        launch("a1", { description: "Explore the cache", subagent_type: "Explore" }),
        read("r1", "a1"),
        acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking" }, _meta: byParent("a1") }),
        agentText("Meanwhile, I read the store."),
        launch("a2", { description: "Nested" }),
        acp({ sessionUpdate: "tool_call", toolCallId: "n1", title: "Inside", status: "pending", _meta: byParent("a1") }),
        acp({ sessionUpdate: "tool_call", toolCallId: "n2", title: "Deeper", status: "pending", _meta: byParent("a2") }),
        acp({ sessionUpdate: "tool_call", toolCallId: "lost", title: "Unknown parent", status: "pending", _meta: byParent("gone") }),
        acp({ sessionUpdate: "plan", entries: [{ content: "subagent's own checklist", priority: "low", status: "pending" }], _meta: byParent("a1") }),
      ]),
    );
    expect(timeline.map((block) => (block.kind === "tool" ? block.title : block.kind))).toEqual(["Task", "agent", "Task", "Unknown parent"]);
    const [first, second] = subagentsIn(timeline);
    expect(first!.subagent.blocks.map((block) => (block.kind === "tool" ? block.title : block.kind))).toEqual(["Read r1.ts", "agent", "Inside"]);
    expect(second!.subagent.blocks.map((block) => (block.kind === "tool" ? block.title : block.kind))).toEqual(["Deeper"]);
    expect(first!.subagent.lastActivityAt).toBe(9000);
  });

  test("a call that says it starts a subagent only in a later update still gathers that subagent's work", () => {
    const timeline = buildTimeline(
      stored([
        acp({ sessionUpdate: "tool_call", toolCallId: "a1", title: "Task", kind: "think", status: "pending" }),
        acp({ sessionUpdate: "tool_call_update", toolCallId: "a1", _meta: { claudeCode: { toolName: "Agent" } } }),
        read("r1", "a1"),
        { type: "turn-end", stopReason: "cancelled" },
      ]),
    );
    expect(timeline.map((block) => (block.kind === "tool" ? block.title : block.kind))).toEqual(["Task", "notice"]);
    const [subagent] = subagentsIn(timeline);
    expect(subagent!.subagent.blocks.map((block) => (block.kind === "tool" ? block.title : block.kind))).toEqual(["Read r1.ts"]);
    expect(subagentState(subagent!, true)).toBe("stopped");
  });

  test("one runs until its call completes, and one in the background until the turn that started it ends", () => {
    const states = (events: ConversationEvent[], busy = true) => subagentsIn(buildTimeline(stored(events))).map((block) => subagentState(block, busy));
    const background = [launch("b1", { description: "Watch the build" }), answeredAtOnce("b1"), finish("b1")];
    expect(states([launch("s1", {}), ...background])).toEqual(["running", "running"]);
    expect(states([launch("s1", {}), finish("s1"), ...background, read("r1", "b1")])).toEqual(["done", "running"]);
    expect(states([...background, { type: "turn-end", stopReason: "end_turn" }])).toEqual(["done"]);
    expect(states([launch("s1", {}), launch("b1", {}), { type: "turn-end", stopReason: "cancelled" }])).toEqual(["stopped", "stopped"]);
    expect(states([launch("s1", {}), finish("s1", "failed")])).toEqual(["failed"]);
    expect(states([launch("s1", {})], false)).toEqual(["stopped"]);
    expect(states([{ type: "turn-end", stopReason: "end_turn" }, launch("s2", {})])).toEqual(["running"]);
  });

  test("an error ends the turn as a stop does, so a subagent it leaves behind stops working with it", () => {
    const states = (events: ConversationEvent[], busy = true) => subagentsIn(buildTimeline(stored(events))).map((block) => subagentState(block, busy));
    const background = [launch("b1", { description: "Watch the build" }), answeredAtOnce("b1"), finish("b1")];
    expect(states([...background, { type: "error", message: "ACP connection closed" }])).toEqual(["stopped"]);
    expect(states([...background, { type: "error", message: "ACP connection closed" }], false)).toEqual(["stopped"]);
  });

  test("ends when its call completes, or at its last activity when it ran in the background", () => {
    const [sync, background] = subagentsIn(
      buildTimeline(stored([launch("s1", {}), launch("b1", {}), answeredAtOnce("b1"), finish("b1"), read("r1", "b1"), finish("s1"), read("r2", "b1")])),
    );
    expect(subagentEndedAt(sync!)).toBe(6000);
    expect(subagentEndedAt(background!)).toBe(7000);
  });
});

describe("startsAuthorGroup", () => {
  test("a block opens a group when its author differs from the one before, and notices belong to no one", () => {
    const block = (kind: string) => ({ kind, key: kind, at: 0, text: "" }) as TimelineBlock;
    const timeline = ["user", "user", "agent", "tool", "notice", "agent", "error", "notice"].map(block);
    expect(timeline.map((_, index) => startsAuthorGroup(timeline, index))).toEqual([true, false, true, false, false, true, false, false]);
  });

  test("a message from a script has its own author, so it never hides in the user's group", () => {
    const timeline = buildTimeline(
      stored([
        { type: "user-message", text: "run the build in the background" },
        { type: "user-message", text: "build finished", fromScript: true },
        { type: "user-message", text: "and then?" },
      ]),
    );
    expect(timeline.map(authorOf)).toEqual(["user", "script", "user"]);
    expect(timeline.map((_, index) => startsAuthorGroup(timeline, index))).toEqual([true, true, true]);
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

describe("images in the agent's updates", () => {
  const png = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };

  test("a replayed user message keeps its image with its text, instead of a placeholder", () => {
    const timeline = buildTimeline(
      stored([
        acp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "what is this?" } }),
        acp({ sessionUpdate: "user_message_chunk", content: png }),
        agentText("A logo."),
      ]),
    );
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ kind: "user", text: "what is this?", images: [png] });
    expect(timeline[1]).toMatchObject({ kind: "agent", text: "A logo." });
  });

  test("an image the agent sends joins its reply", () => {
    const timeline = buildTimeline(stored([{ type: "user-message", text: "draw" }, agentText("Here:"), acp({ sessionUpdate: "agent_message_chunk", content: png })]));
    expect(timeline.at(-1)).toMatchObject({ kind: "agent", text: "Here:", images: [png] });
  });

  test("an image that starts a message makes a message of its own", () => {
    const timeline = buildTimeline(stored([{ type: "user-message", text: "draw" }, acp({ sessionUpdate: "agent_message_chunk", content: png })]));
    expect(timeline.at(-1)).toMatchObject({ kind: "agent", text: "", images: [png] });
  });
});
