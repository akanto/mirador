import { useSyncExternalStore } from "react";
import type { SlashCommand } from "../shared/slash-commands.ts";

/** Mirador's own /login, since the agents leave theirs out of the commands they offer over ACP. */
export const loginSlashCommand: SlashCommand = { name: "login", description: "Sign the agent in again, in a terminal tab", hint: null };

export const isLoginCommand = (message: string) => message.trim() === `/${loginSlashCommand.name}`;

/** The conversation whose agent is to sign in, until the terminal pane, which may first have to be shown, opens its tab. */
let waiting: string | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

export function requestLogin(conversationId: string) {
  waiting = conversationId;
  changed();
}

export function takeLoginRequest() {
  const conversationId = waiting;
  waiting = null;
  changed();
  return conversationId;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useLoginRequest = () => useSyncExternalStore(subscribe, () => waiting);
