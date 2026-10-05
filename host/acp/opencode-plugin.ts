import { jobWaitGuidance } from "../job-waits.ts";

/**
 * The opencode Mirador runs loads this (see withMiradorPlugin): it tells the agent about `mirador when-done`, as Claude
 * Code's system prompt does, and gives each command the agent runs its session's id, as Claude Code's commands have.
 */
export const MiradorPlugin = async () => ({
  "shell.env": async (input: { sessionID?: string }, output: { env: Record<string, string> }) => {
    if (input.sessionID) output.env.MIRADOR_SESSION_ID = input.sessionID;
  },
  "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
    output.system.push(jobWaitGuidance);
  },
});
