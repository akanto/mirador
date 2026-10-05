import type { Conversation, WaitingFor } from "./model.ts";

export type WaitingTone = "decision" | "failed" | "done";

export const waitingTones: Record<WaitingFor, WaitingTone> = {
  permission: "decision",
  question: "decision",
  error: "failed",
  finished: "done",
};

export const waitingLabels: Record<WaitingTone, string> = {
  decision: "Needs you",
  failed: "Failed",
  done: "Done",
};

export const tonesByUrgency: WaitingTone[] = ["decision", "failed", "done"];

const urgencyOf = ({ waitingFor }: Conversation) => (waitingFor ? tonesByUrgency.indexOf(waitingTones[waitingFor]) : -1);

export const mostUrgentTone = (waiting: WaitingFor[]) =>
  tonesByUrgency.find((tone) => waiting.some((waitingFor) => waitingTones[waitingFor] === tone));

/** Decisions first, since those agents are stuck until you answer; otherwise in the order given. */
export const waitingByUrgency = (conversations: Conversation[]) =>
  conversations.filter(({ waitingFor }) => waitingFor !== null).sort((a, b) => urgencyOf(a) - urgencyOf(b));
