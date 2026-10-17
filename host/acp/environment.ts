import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { accountShell } from "../../shared/login-shell.ts";

let lookedUpShell: string | undefined;

/** The shell the user logs in with, even when the host was started without $SHELL (e.g. by launchd or systemd). */
export const loginShell = () => process.env.SHELL || (lookedUpShell ??= accountShell() ?? "/bin/sh");

const sessionScopedPrefixes = ["CMUX_", "TMUX", "CLAUDE_CODE_SESSION", "CLAUDE_CODE_MESSAGING"];

const sessionScopedNames = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_EXECUTABLE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_JOB_DIR",
  "ANTHROPIC_MODEL",
  "NODE_OPTIONS",
  "MIRADOR_URL",
  "MIRADOR_SCRIPT_TOKEN",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
]);

const isSessionScoped = (name: string) =>
  sessionScopedNames.has(name) || sessionScopedPrefixes.some((prefix) => name.startsWith(prefix));

/**
 * Windows calls it Path and takes environment names in any case, but a copy of the environment is a plain object: one
 * that kept Path would gain a second PATH holding only what the host adds to it, and the agent would get that one.
 */
const namedAsEverywhere = ([name, value]: [string, string]): [string, string] =>
  process.platform === "win32" && name.toUpperCase() === "PATH" ? ["PATH", value] : [name, value];

/**
 * The host may itself be launched from inside a Claude Code, cmux or Mirador session; those
 * sessions export variables that would make the spawned agents believe they are
 * nested children of that session.
 */
export function agentEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(base)
      .filter((entry): entry is [string, string] => entry[1] !== undefined && !isSessionScoped(entry[0]))
      .map(namedAsEverywhere),
  );
}

/** By URL rather than Bun's import.meta.dir, since e2e specs load this file in Node. */
const miradorCommandDirectory = fileURLToPath(new URL("../../bin", import.meta.url));

/** Last, so the agent's own commands keep their names. */
const withMiradorCommand = (path: string | undefined) =>
  path?.split(delimiter).includes(miradorCommandDirectory) ? path : [path, miradorCommandDirectory].filter(Boolean).join(delimiter);

/** The mirador command on the agent's PATH, run on the host's own Bun: the desktop app's, where no other is installed. */
export const miradorCommandEnvironment = (path: string | undefined) => ({ PATH: withMiradorCommand(path), MIRADOR_BUN: process.execPath });
