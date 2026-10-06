import type { ConversationEvent, StoredEvent } from "./model.ts";

/** A turn whose files the user put back, and what the restore did. */
export interface Revert {
  revertId: string;
  /** The turn the files were put back to: its message is the last one whose changes are still in the files. */
  toSeq: number;
  toMessage: string;
  restored: number;
  removed: number;
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
    .map(({ revertId, toSeq, restored, removed }) => ({ revertId, toSeq, restored, removed, toMessage: messageOf(events, toSeq) }));
}

/** A turn whose files Mirador kept, so the files can be put back to how they were before it began. */
export interface UndoableTurn {
  seq: number;
  text: string;
}

/** The turns of the conversation that can be undone, oldest first. */
export function undoableTurns(events: StoredEvent[]): UndoableTurn[] {
  return events.flatMap(({ seq, event }) => (event.type === "user-message" && event.checkpoint ? [{ seq, text: event.text }] : []));
}

/** The start of a turn's message, short enough to name that turn in a label or a note. */
export function turnTitle(text: string) {
  const first = text.trim().split("\n")[0];
  return first.length > 60 ? `${first.slice(0, 60)}…` : first || "an earlier turn";
}

export const whatChanged = ({ restored, removed }: Pick<Revert, "restored" | "removed">) => {
  const files = (count: number, what: string) => `${count} ${count === 1 ? "file" : "files"} ${what}`;
  const parts = [restored > 0 && files(restored, "put back as they were"), removed > 0 && files(removed, "created since deleted")].filter(Boolean);
  return parts.length > 0 ? parts.join(" and ") : "no file was different";
};

/** How the agent is told its changes are no longer in the files, ahead of the message it is being sent. */
export function withRevertNotes(reverts: Revert[], message: string) {
  if (reverts.length === 0) return message;
  const notes = reverts.map(
    (revert) =>
      `The user put this workspace's files back to how they were before the turn that began with "${revert.toMessage}": ${whatChanged(revert)}. ` +
      "The conversation above is unchanged, but the files no longer hold what was changed or created after that point.",
  );
  return `${notes.join("\n\n")}\n\n${message}`;
}
