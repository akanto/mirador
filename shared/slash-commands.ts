import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { StoredEvent } from "./model.ts";

/** A command the agent takes as a message starting with /name, e.g. /compact; hint describes what may follow it. */
export interface SlashCommand {
  name: string;
  description: string;
  hint: string | null;
}

/** What is typed after the `/` while the message is only a command name being written; null otherwise. */
export function slashQuery(text: string): string | null {
  return /^\/(\S*)$/.exec(text)?.[1] ?? null;
}

/**
 * The commands whose name holds the query: first those starting with it, the shortest (closest) first, then the rest
 * in the agent's order. A bare / lists them all in the agent's order.
 */
export function matchingCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return commands;
  const wanted = query.toLowerCase();
  const named = commands.filter(({ name }) => name.toLowerCase().includes(wanted));
  const startsWithQuery = ({ name }: SlashCommand) => name.toLowerCase().startsWith(wanted);
  const closestFirst = named.filter(startsWithQuery).toSorted((one, other) => one.name.length - other.name.length);
  return [...closestFirst, ...named.filter((command) => !startsWithQuery(command))];
}

/** The commands the agent last said it has in this conversation, or null if it has not said yet. */
export function latestSlashCommands(events: StoredEvent[]): SlashCommand[] | null {
  const latest = events.findLast(({ event }) => event.type === "acp" && event.update.sessionUpdate === "available_commands_update");
  if (latest?.event.type !== "acp" || latest.event.update.sessionUpdate !== "available_commands_update") return null;
  return latest.event.update.availableCommands.map(toSlashCommand);
}

export const toSlashCommand = ({ name, description, input }: AvailableCommand): SlashCommand => ({
  name,
  description,
  hint: input?.hint ?? null,
});
