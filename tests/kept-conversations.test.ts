import { expect, test } from "bun:test";
import type { StoredEvent } from "../shared/model.ts";
import { KEPT_CONVERSATIONS, initialState, reducer, selectedOpen, type AppState } from "../web/state.ts";

const selecting = (state: AppState, conversationId: string | null) => reducer(state, { type: "select", conversationId });
const event = (seq: number): StoredEvent => ({ seq, at: seq, event: { type: "user-message", text: `message ${seq}` } });
const keptIds = (state: AppState) => state.kept.map(({ conversationId }) => conversationId);

test("the page keeps the conversations selected last, the selected one first, and lets the oldest go", () => {
  const ids = Array.from({ length: KEPT_CONVERSATIONS + 1 }, (_, index) => `c${index}`);
  const state = ids.reduce(selecting, initialState);
  expect(keptIds(state)).toEqual(ids.slice(1).reverse());
  expect(keptIds(selecting(state, "c3"))).toEqual(["c3", "c5", "c4", "c2", "c1"]);
});

test("events reach a kept conversation while another is shown, and it shows them when selected again", () => {
  const history = { type: "conversation.history" as const, conversationId: "a", events: [event(1)], canvas: [] };
  let state = reducer(selecting(initialState, "a"), { type: "server", message: history });
  state = selecting(state, "b");
  state = reducer(state, { type: "server", message: { type: "conversation.event", conversationId: "a", event: event(2) } });
  expect(selectedOpen(state)?.conversationId).toBe("b");
  expect(selectedOpen(selecting(state, "a"))).toMatchObject({ loaded: true, events: [event(1), event(2)] });
});

test("a deleted conversation is no longer kept, and the others stay", () => {
  const state = ["a", "b"].reduce(selecting, initialState);
  const afterDeleting = reducer(state, { type: "server", message: { type: "conversation.deleted", conversationId: "a" } });
  expect(keptIds(afterDeleting)).toEqual(["b"]);
  expect(afterDeleting.selectedConversationId).toBe("b");
});
