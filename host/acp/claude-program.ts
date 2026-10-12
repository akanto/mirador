import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeProgram } from "../../shared/model.ts";

/** Where Claude Code's installers put it (native, Homebrew, npm), for hosts started without a login shell's PATH. */
const claudeInstallDirectories = () => [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];

export const claudeProgramMissing = (configured: string) =>
  configured
    ? `The Claude Code program set in Settings › Agents, ${configured}, does not exist or cannot run.`
    : "Claude Code is not installed: no claude on PATH or in ~/.local/bin, /opt/homebrew/bin or /usr/local/bin. " +
      "Install it with `curl -fsSL https://claude.ai/install.sh | bash`, or set its path in Settings › Agents.";

/** The Claude Code this computer has: the program set in Settings, else the claude on PATH or in an installer's directory. */
export function findClaudeProgram(configured: string, path = process.env.PATH): string | null {
  if (configured) return Bun.which(configured.replace(/^~(?=\/)/, homedir()));
  return Bun.which("claude", { PATH: path }) ?? Bun.which("claude", { PATH: claudeInstallDirectories().join(":") });
}

/** A broken install can hang on --version, e.g. one stuck on a terminal; its version stays unknown rather than holding up Settings. */
const VERSION_TIMEOUT_MS = 10_000;

export async function versionOf(program: string, timeout = VERSION_TIMEOUT_MS): Promise<string | null> {
  try {
    const run = Bun.spawn([program, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout });
    const [output, exitCode] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    return exitCode === 0 ? output.trim().split("\n")[0]! : null;
  } catch {
    return null;
  }
}

export async function describeClaudeProgram(configured: string): Promise<ClaudeProgram> {
  const found = findClaudeProgram(configured);
  return { configured, found, version: found && (await versionOf(found)) };
}
