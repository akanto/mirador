import type { SlashCommand } from "./slash-commands.ts";

/**
 * The commands Claude Code opens a panel for in its own terminal, and refuses over ACP with "isn't available in this
 * environment". Mirador runs them in a terminal tab instead, where the Claude Code the conversation's profile uses
 * shows the panel itself. Found by asking Claude Code 2.1.284 for each of them; a later version may add more, which
 * the refusedPanelCommand fallback catches.
 */
export const panelSlashCommands: SlashCommand[] = [
  { name: "plugin", description: "Install, enable and disable plugins, in a terminal tab", hint: null },
  { name: "hooks", description: "See and change the commands Claude Code runs around the agent, in a terminal tab", hint: null },
  { name: "permissions", description: "See and change what the agent may do without asking, in a terminal tab", hint: null },
  { name: "memory", description: "See and change what Claude Code remembers between sessions, in a terminal tab", hint: null },
  { name: "status", description: "The session, account and settings the agent runs with, in a terminal tab", hint: null },
  { name: "release-notes", description: "What changed in Claude Code lately, in a terminal tab", hint: null },
  { name: "help", description: "Claude Code's own help, in a terminal tab", hint: null },
  { name: "ide", description: "Connect Claude Code to an editor, in a terminal tab", hint: null },
  { name: "terminal-setup", description: "Set up a terminal's keys for Claude Code, in a terminal tab", hint: null },
];

/** The panel command a message asks for, with what follows it, or null when it asks for none of them. */
export function panelCommandLine(message: string): string | null {
  const [name] = message.trim().split(/\s+/);
  return panelSlashCommands.some((command) => `/${command.name}` === name) ? message.trim() : null;
}

/**
 * The line a panel command runs, on either path (a listed command or a refused one), or null for anything that is not a
 * slash command. The host holds a request to this shape, so a client cannot have it run Claude Code with arguments of
 * its own choosing.
 */
export function panelCommandRun(line: string): string | null {
  const command = line.trim();
  return /^\/[a-z][a-z0-9-]*(?: [^\n]*)?$/.test(command) ? command : null;
}

/** The command Claude Code said it cannot open here, for the button that opens a terminal tab for it instead. */
export function refusedPanelCommand(text: string): string | null {
  const match = /^\/([a-z-]+) isn't available in this environment\.$/.exec(text.trim());
  return match?.[1] ?? null;
}
