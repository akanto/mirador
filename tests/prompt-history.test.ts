import { describe, expect, test } from "bun:test";
import type { ConversationEvent, StoredEvent } from "../shared/model.ts";
import { promptHistory, steppedTo } from "../shared/prompt-history.ts";

const stored = (events: ConversationEvent[]): StoredEvent[] => events.map((event, seq) => ({ seq, at: seq, event }));
const texts = (events: ConversationEvent[], typedElsewhere: string[] = []) => promptHistory(stored(events), typedElsewhere).map(({ text }) => text);

describe("prompt history", () => {
  test("holds what the user typed, newest first: messages and shell commands, not what a script sent", () => {
    const events: ConversationEvent[] = [
      { type: "user-message", text: "first" },
      { type: "turn-end", stopReason: "end_turn" },
      { type: "user-command", commandId: "c1", command: "ls -la" },
      { type: "user-message", text: "from a script", fromScript: true },
      { type: "user-message", text: "/compact" },
    ];
    expect(texts(events)).toEqual(["/compact", "!ls -la", "first"]);
  });

  test("goes on to what was typed in the workspace's other conversations, each text once at its newest", () => {
    const events: ConversationEvent[] = [
      { type: "user-message", text: "again" },
      { type: "user-message", text: "mine" },
      { type: "user-message", text: "again" },
      { type: "user-message", text: " " },
    ];
    expect(texts(events, ["elsewhere", "mine", "older elsewhere"])).toEqual(["again", "mine", "elsewhere", "older elsewhere"]);
  });

  test("keeps the images of the conversation's own messages", () => {
    const [entry] = promptHistory(stored([{ type: "user-message", text: "[Image #1] what is this?", imageIds: ["i1"] }]), []);
    expect(entry).toEqual({ text: "[Image #1] what is this?", imageIds: ["i1"] });
  });

  test("steps back one entry at a time and forward again, past the newest to the draft", () => {
    const history = ["c", "b", "a"].map((text) => ({ text, imageIds: [] }));
    expect(steppedTo(history, null, "older")).toBe(0);
    expect(steppedTo(history, "c", "older")).toBe(1);
    expect(steppedTo(history, "a", "older")).toBeNull();
    expect(steppedTo(history, "b", "newer")).toBe(0);
    expect(steppedTo(history, "c", "newer")).toBe("draft");
    expect(steppedTo(history, null, "newer")).toBeNull();
    expect(steppedTo([], null, "older")).toBeNull();
  });
});
