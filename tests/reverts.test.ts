import { expect, test } from "bun:test";
import type { ConversationEvent, StoredEvent } from "../shared/model.ts";
import { joinedRunningTurn, lastAgentMessageId, pendingReverts, rewindPointBefore, turnTitle, turnsFrom, undoableTurns, whatChanged, whatWasLeft, whyNoRewindTo, withRevertNotes } from "../shared/reverts.ts";

const userMessage = (text: string, extra: Partial<Extract<ConversationEvent, { type: "user-message" }>> = {}) =>
  ({ type: "user-message", text, ...extra }) as ConversationEvent;
const revertEvent = (revertId: string, toSeq: number, restored = 1, removed = 0) => ({ type: "revert", revertId, toSeq, restored, removed }) as ConversationEvent;
const said = (messageId?: string) =>
  ({ type: "acp", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" }, ...(messageId && { messageId }) } }) as ConversationEvent;
const stored = (...events: ConversationEvent[]): StoredEvent[] => events.map((event, index) => ({ seq: index + 1, at: 0, event }));

test("a turn is undoable when Mirador kept the files it began with", () => {
  const events = stored(userMessage("first", { checkpoint: "abc" }), userMessage("second"), userMessage("third", { checkpoint: "def" }));
  expect(undoableTurns(events)).toEqual([
    { seq: 1, text: "first" },
    { seq: 3, text: "third" },
  ]);
});

test("a revert note is pending until a message of the user's carries it", () => {
  const events = stored(userMessage("do the thing"), revertEvent("r1", 1, 2, 1));
  expect(pendingReverts(events)).toEqual([{ revertId: "r1", toSeq: 1, restored: 2, removed: 1, toMessage: "do the thing" }]);
  expect(pendingReverts(stored(...events.map(({ event }) => event), userMessage("carry on", { attachedRevertIds: ["r1"] })))).toEqual([]);
});

test("a revert note that went with a message the agent never answered is pending again", () => {
  const events = stored(
    userMessage("do the thing"),
    revertEvent("r1", 1),
    userMessage("carry on", { attachedRevertIds: ["r1"] }),
    { type: "turn-end", stopReason: "cancelled" },
    { type: "steered-messages-returned", seqs: [3] },
  );
  expect(pendingReverts(events).map(({ revertId }) => revertId)).toEqual(["r1"]);
});

test("a revert's note names the turn it went back to, and says what changed", () => {
  const revert = { revertId: "r1", toSeq: 1, toMessage: "do the thing", restored: 3, removed: 1 };
  const note = withRevertNotes([revert], "carry on");
  expect(note).toContain('before the turn that began with "do the thing": 3 files put back as they were and 1 file created since deleted.');
  expect(note.endsWith("carry on")).toBe(true);
  expect(withRevertNotes([], "carry on")).toBe("carry on");
});

test("a revert that left submodules as they are tells the agent so", () => {
  const revert = { revertId: "r1", toSeq: 1, toMessage: "do the thing", restored: 1, removed: 0, submodulesLeft: 2 };
  expect(withRevertNotes([revert], "carry on")).toContain(
    "1 file put back as they were. 2 submodules that changed stay as they are now: a submodule's files are its own repository's, so Mirador does not put them back. The conversation above is unchanged",
  );
  expect(whatWasLeft({ submodulesLeft: 1 })).toStartWith("1 submodule that changed stays as it is now");
  expect(whatWasLeft({})).toBe("");
});

test("one file is not called files, and an unchanged tree says so", () => {
  expect(whatChanged({ restored: 1, removed: 0 })).toBe("1 file put back as they were");
  expect(whatChanged({ restored: 0, removed: 0 })).toBe("no file was different");
});

test("a turn is named by its message's first line, shortened when long", () => {
  expect(turnTitle("Fix the parser\nand its tests")).toBe("Fix the parser");
  expect(turnTitle(`${"x".repeat(80)}`)).toHaveLength(61);
  expect(turnTitle("   ")).toBe("an earlier turn");
});

test("a shortened turn title keeps an emoji whole", () => {
  const title = turnTitle(`${"a".repeat(59)}😀b`);
  expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  expect(title).not.toMatch(/^[\uDC00-\uDFFF]/);
  expect(title).toBe(`${"a".repeat(59)}😀…`);
});

test("a shortened turn title keeps a character made of several code points whole", () => {
  for (const cluster of ["🇭🇺", "👨‍👩‍👧", "1️⃣", "👍🏽", "é"]) {
    expect(turnTitle(`${"a".repeat(59)}${cluster} and more text`)).toBe(`${"a".repeat(59)}${cluster}…`);
  }
});

test("a rewind to a turn leaves the turns from there on, and none before it", () => {
  const events = stored(userMessage("first"), userMessage("second"), userMessage("third"));
  expect(turnsFrom(events, 2)).toEqual([
    { seq: 2, text: "second" },
    { seq: 3, text: "third" },
  ]);
  expect(turnsFrom(events, 1)).toHaveLength(3);
});

test("a rewind goes back to the last thing the agent said before the turn", () => {
  const events = stored(userMessage("first"), said("msg_1"), said("msg_1"), said("msg_2"), userMessage("second"), said("msg_3"));
  expect(rewindPointBefore(events, 5)).toBe("msg_2");
});

test("a rewind to the first turn has nothing of the agent's to go back to", () => {
  expect(rewindPointBefore(stored(userMessage("first"), said("msg_1")), 1)).toBeNull();
  expect(rewindPointBefore(stored(said(), userMessage("first")), 2)).toBeNull();
});

test("an agent that can go back to a marked reply can take a conversation back there; one that can't is refused", () => {
  const events = stored(userMessage("first"), said("msg_1"), userMessage("second"));
  expect(whyNoRewindTo("claude", events, 3)).toBeUndefined();
  expect(whyNoRewindTo("opencode", events, 3)).toContain("which opencode can't do");
});

test("with no reply marked, only a first turn can be taken back, by starting the agent afresh", () => {
  expect(whyNoRewindTo("opencode", stored(said(), userMessage("first"), said()), 2)).toBeUndefined();
  const unmarkedTurns = stored(userMessage("first"), said(), userMessage("second"), said());
  for (const harness of ["claude", "opencode", "pi"] as const) expect(whyNoRewindTo(harness, unmarkedTurns, 3)).toContain("no mark");
});

test("a message sent while a turn ran joined it, and the next one after the turn ended or failed starts its own", () => {
  const cancelled: ConversationEvent = { type: "turn-end", stopReason: "cancelled" };
  const events = stored(userMessage("first"), said("msg_1"), userMessage("Also this"), cancelled, userMessage("third"), { type: "error", message: "boom" }, userMessage("fourth"));
  expect([1, 3, 5, 7].map((seq) => joinedRunningTurn(events, seq))).toEqual([false, true, false, false]);
});

test("a message that went out again after its turn starts the next turn, as the agent never had it", () => {
  const events = stored(userMessage("first"), userMessage("Also this"), { type: "turn-end", stopReason: "cancelled" }, { type: "steered-messages-returned", seqs: [2] }, userMessage("Also this"), userMessage("And that"));
  expect([5, 6].map((seq) => joinedRunningTurn(events, seq))).toEqual([false, true]);
});

test("turns taken elsewhere pick up after the agent's latest message in the conversation", () => {
  expect(lastAgentMessageId(stored(userMessage("first"), said("msg_1"), userMessage("second"), said("msg_2"), said()))).toBe("msg_2");
  expect(lastAgentMessageId(stored(userMessage("first")))).toBeNull();
});
