import { useState } from "react";
import type { Conversation, WaitingFor } from "../shared/model.ts";

export type WaitingStyle = "pills" | "dots" | "list";

export const waitingStyleLabels: Record<WaitingStyle, string> = {
  pills: "Pill and count",
  dots: "Dot only",
  list: "Pills and a list on top",
};

const STORAGE_KEY = "mirador-waiting-style";

export function storedWaitingStyle(): WaitingStyle {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "dots" || saved === "list" ? saved : "pills";
  } catch {
    return "pills";
  }
}

/** The stylesheet hides the pills and counts, or shows the list on top, by the root element's data-waiting. */
export function applyWaitingStyle(style: WaitingStyle) {
  document.documentElement.dataset.waiting = style;
}

export function useWaitingStyle() {
  const [style, setStyle] = useState(storedWaitingStyle);
  const choose = (next: WaitingStyle) => {
    applyWaitingStyle(next);
    setStyle(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  };
  return [style, choose] as const;
}

export type WaitingTone = "decision" | "failed" | "done";

export const waitingTones: Record<WaitingFor, WaitingTone> = { permission: "decision", question: "decision", error: "failed", finished: "done" };

export const waitingLabels: Record<WaitingTone, string> = { decision: "Needs you", failed: "Failed", done: "Done" };

const urgency: WaitingTone[] = ["decision", "failed", "done"];
const urgencyOf = ({ waitingFor }: Conversation) => urgency.indexOf(waitingTones[waitingFor!]);

export const mostUrgentTone = (waiting: WaitingFor[]) => urgency.find((tone) => waiting.some((waitingFor) => waitingTones[waitingFor] === tone));

/** Decisions first, since those agents are stuck until you answer; otherwise in the order given. */
export const waitingByUrgency = (conversations: Conversation[]) =>
  conversations.filter(({ waitingFor }) => waitingFor !== null).sort((a, b) => urgencyOf(a) - urgencyOf(b));
