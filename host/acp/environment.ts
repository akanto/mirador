import { userInfo } from "node:os";

/** The shell the user logs in with, even when the host was started without $SHELL (e.g. by launchd). */
export const loginShell = () => process.env.SHELL || userInfo().shell || "/bin/sh";

const sessionScopedPrefixes = ["CMUX_", "TMUX", "CLAUDE_CODE_SESSION", "CLAUDE_CODE_MESSAGING"];

const sessionScopedNames = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_JOB_DIR",
  "ANTHROPIC_MODEL",
  "NODE_OPTIONS",
]);

const isSessionScoped = (name: string) =>
  sessionScopedNames.has(name) || sessionScopedPrefixes.some((prefix) => name.startsWith(prefix));

/**
 * The host may itself be launched from inside a Claude Code or cmux session; those
 * sessions export variables that would make the spawned agents believe they are
 * nested children of that session.
 */
export function agentEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !isSessionScoped(entry[0]),
    ),
  );
}
