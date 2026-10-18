import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { cancelledReplyChunks, type CancelledReplyChunks } from "../host/conversations.ts";

const chunk = (text: string, messageId?: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId });

test("every late chunk of the reply a stopped turn was already streaming is dropped, nothing held back for it", () => {
  let pending: CancelledReplyChunks = { messageId: "msg-cut-off" };
  for (const text of ["Here", " is the", " answer"]) {
    const verdict = cancelledReplyChunks(pending, chunk(text, "msg-cut-off"));
    expect(verdict.drop).toBe(true);
    expect(verdict.pending!.held).toBeUndefined();
    pending = verdict.pending!;
  }
});

test("the first reply after a stop that saw no chunk is held back whole while it streams under its id", () => {
  const started = cancelledReplyChunks({ messageId: null, held: [] }, chunk("Answering", "msg-unknown"));
  expect(started.drop).toBe(true);
  expect(started.pending!.messageId).toBe("msg-unknown");
  const continued = cancelledReplyChunks(started.pending!, chunk(" at once", "msg-unknown"));
  expect(continued.drop).toBe(true);
  expect(continued.pending!.held!.map((update) => (update as { content: { text: string } }).content.text)).toEqual(["Answering", " at once"]);
});

test("a reply with another id ends the claim: the held-back one was the cancelled turn's orphan, this one shows", () => {
  const heldBack = cancelledReplyChunks({ messageId: null, held: [] }, chunk("Answering", "msg-orphan")).pending!;
  const verdict = cancelledReplyChunks(heldBack, chunk("Answered after the stop", "msg-next-turn"));
  expect(verdict.drop).toBe(false);
  expect(verdict.pending).toBeNull();
});

test("chunks with no id keep the claim waiting, held back with it", () => {
  const waiting = cancelledReplyChunks({ messageId: null, held: [] }, chunk("No id yet"));
  expect(waiting.drop).toBe(true);
  expect(waiting.pending!.messageId).toBeNull();
  expect(waiting.pending!.held).toHaveLength(1);
});
