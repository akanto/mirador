import type { ConversationEvent, StoredEvent } from "./model.ts";

/** A turn whose files the user put back, and what the restore did. */
export interface Revert {
  revertId: string;
  /** The turn the files were put back to: its message is the last one whose changes are still in the files. */
  toSeq: number;
  toMessage: string;
  restored: number;
  removed: number;
  submodulesLeft?: number;
}

const messageOf = (events: StoredEvent[], seq: number) => {
  const event = events.find((stored) => stored.seq === seq)?.event;
  return event?.type === "user-message" ? event.text : "";
};

/** The reverts whose note has not gone to the agent with a message of the user's yet. */
export function pendingReverts(events: StoredEvent[]): Revert[] {
  const sent = new Set(events.flatMap(({ event }) => (event.type === "user-message" ? (event.attachedRevertIds ?? []) : [])));
  return events
    .filter(({ event }) => event.type === "revert")
    .map(({ event }) => event as Extract<ConversationEvent, { type: "revert" }>)
    .filter(({ revertId }) => !sent.has(revertId))
    .map(({ revertId, toSeq, restored, removed, submodulesLeft }) => ({ revertId, toSeq, restored, removed, ...(submodulesLeft && { submodulesLeft }), toMessage: messageOf(events, toSeq) }));
}

/** A turn of the conversation, named by the message that began it. */
export interface Turn {
  seq: number;
  text: string;
}

/** The turns of the conversation whose files Mirador kept, so they can be put back, oldest first. */
export function undoableTurns(events: StoredEvent[]): Turn[] {
  return events.flatMap(({ seq, event }) => (event.type === "user-message" && event.checkpoint ? [{ seq, text: event.text }] : []));
}

/** The turns from `seq` on: what a rewind to that point takes out of the conversation. */
export function turnsFrom(events: StoredEvent[], seq: number): Turn[] {
  return events.flatMap(({ seq: at, event }) => (event.type === "user-message" && at >= seq ? [{ seq: at, text: event.text }] : []));
}

/**
 * The agent's own mark of the last thing it said before the turn at `seq`, which is where a rewind sends its session
 * back to: a fork point names an assistant message, and the agent hands out one mark per reply that both its live
 * session and its transcript on disk agree on.
 */
export function rewindPointBefore(events: StoredEvent[], seq: number): string | null {
  const said = events.flatMap(({ seq: at, event }) =>
    at < seq && event.type === "acp" && event.update.sessionUpdate === "agent_message_chunk" && event.update.messageId
      ? [event.update.messageId]
      : [],
  );
  return said.at(-1) ?? null;
}

/** The agent's latest message in the conversation, where turns taken elsewhere since pick up. */
export const lastAgentMessageId = (events: StoredEvent[]) => rewindPointBefore(events, Infinity);

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The start of a turn's message, short enough to name that turn in a label or a note. */
export function turnTitle(text: string) {
  const first = text.trim().split("\n")[0];
  const characters = [...graphemes.segment(first)].map(({ segment }) => segment);
  return characters.length > 60 ? `${characters.slice(0, 60).join("")}…` : first || "an earlier turn";
}

export const whatChanged = ({ restored, removed }: Pick<Revert, "restored" | "removed">) => {
  const files = (count: number, what: string) => `${count} ${count === 1 ? "file" : "files"} ${what}`;
  const parts = [restored > 0 && files(restored, "put back as they were"), removed > 0 && files(removed, "created since deleted")].filter(Boolean);
  return parts.length > 0 ? parts.join(" and ") : "no file was different";
};

/** What a restore does not put back, said after what it does; empty when nothing was left. */
export const whatWasLeft = ({ submodulesLeft = 0 }: Pick<Revert, "submodulesLeft">) =>
  submodulesLeft === 0
    ? ""
    : `${submodulesLeft === 1 ? "1 submodule that changed stays as it is" : `${submodulesLeft} submodules that changed stay as they are`} now: a submodule's files are its own repository's, so Mirador does not put them back.`;

/** How the agent is told its changes are no longer in the files, ahead of the message it is being sent. */
export function withRevertNotes(reverts: Revert[], message: string) {
  if (reverts.length === 0) return message;
  const notes = reverts.map((revert) =>
    [
      `The user put this workspace's files back to how they were before the turn that began with "${revert.toMessage}": ${whatChanged(revert)}.`,
      whatWasLeft(revert),
      "The conversation above is unchanged, but the files no longer hold what was changed or created after that point.",
    ]
      .filter(Boolean)
      .join(" "),
  );
  return `${notes.join("\n\n")}\n\n${message}`;
}
