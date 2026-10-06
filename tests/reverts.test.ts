import { expect, test } from "bun:test";
import type { ConversationEvent, StoredEvent } from "../shared/model.ts";
import { pendingReverts, turnTitle, undoableTurns, whatChanged, withRevertNotes } from "../shared/reverts.ts";

const userMessage = (text: string, extra: Partial<Extract<ConversationEvent, { type: "user-message" }>> = {}) =>
  ({ type: "user-message", text, ...extra }) as ConversationEvent;
const revertEvent = (revertId: string, toSeq: number, restored = 1, removed = 0) => ({ type: "revert", revertId, toSeq, restored, removed }) as ConversationEvent;
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

test("a revert's note names the turn it went back to, and says what changed", () => {
  const revert = { revertId: "r1", toSeq: 1, toMessage: "do the thing", restored: 3, removed: 1 };
  const note = withRevertNotes([revert], "carry on");
  expect(note).toContain('before the turn that began with "do the thing": 3 files put back as they were and 1 file created since deleted.');
  expect(note.endsWith("carry on")).toBe(true);
  expect(withRevertNotes([], "carry on")).toBe("carry on");
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
