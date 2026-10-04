import { useSyncExternalStore } from "react";

/** A program the terminal pane opens in a tab of its own: the agent's sign-in, or a waited-for job followed. */
export type ProgramRequest = { type: "terminal.open-login"; conversationId: string } | { type: "terminal.follow-job"; conversationId: string; waitId: string };

/** Until the terminal pane, which may first have to be shown, opens its tab. */
let waiting: ProgramRequest | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

export function requestProgram(request: ProgramRequest) {
  waiting = request;
  changed();
}

export function takeProgramRequest() {
  const request = waiting;
  waiting = null;
  changed();
  return request;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useProgramRequest = () => useSyncExternalStore(subscribe, () => waiting);
