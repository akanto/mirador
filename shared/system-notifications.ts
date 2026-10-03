import type { Conversation } from "./model.ts";

/** Why a conversation needs you: everything that makes it your move. */
export type NotificationReason =
  | { kind: "question"; question: string }
  | { kind: "permission"; tool?: string | null }
  | { kind: "finished" }
  | { kind: "error"; message: string };

export interface SystemNotification {
  /** Set when another machine sent it on through this host; the conversation is that machine's. */
  machineId?: string;
  conversationId: string;
  title: string;
  workspace: string;
  body: string;
}

const BODY_LENGTH = 200;

function reasonText(reason: NotificationReason) {
  switch (reason.kind) {
    case "question":
      return `Asks: ${reason.question}`;
    case "permission":
      return `Wants permission: ${reason.tool || "a tool"}`;
    case "finished":
      return "Finished, waiting for you";
    case "error":
      return `Stopped with an error: ${reason.message}`;
  }
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const shortened = (text: string) => (text.length > BODY_LENGTH ? `${text.slice(0, BODY_LENGTH - 1)}…` : text);

export const systemNotification = (conversation: Pick<Conversation, "id" | "title">, workspace: string, reason: NotificationReason): SystemNotification => ({
  conversationId: conversation.id,
  title: conversation.title,
  workspace,
  body: shortened(oneLine(reasonText(reason))),
});

export type TurnOutcome = { stopReason: string } | { error: string };

/** A turn you cancelled, or one whose queued message goes out right away, is not your move. */
export function turnEndReason(outcome: TurnOutcome, messagesQueued: boolean): Extract<NotificationReason, { kind: "finished" | "error" }> | null {
  if (messagesQueued) return null;
  if ("error" in outcome) return { kind: "error", message: outcome.error };
  return outcome.stopReason === "cancelled" ? null : { kind: "finished" };
}

/** Where a notification has no subtitle line (browsers, Linux), the workspace leads the body. */
export const bodyWithWorkspace = ({ workspace, body }: SystemNotification) => (workspace ? `${workspace} · ${body}` : body);
