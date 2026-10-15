import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Subprocess } from "bun";
import type { ClaudeProgram } from "../../shared/model.ts";
import { killProcessTree } from "../windows-processes.ts";

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
  return Bun.which("claude", { PATH: path }) ?? Bun.which("claude", { PATH: claudeInstallDirectories().join(delimiter) });
}

/** A broken install can hang on --version, e.g. one stuck on a terminal; its version stays unknown rather than holding up Settings. */
const VERSION_TIMEOUT_MS = 10_000;

/** On Windows claude is often a claude.cmd, whose cmd.exe runs the real program: ending cmd.exe alone would leave that running. */
const endStuckRun = (run: Subprocess) => (process.platform === "win32" ? void killProcessTree(run.pid) : run.kill("SIGKILL"));

export async function versionOf(program: string, timeout = VERSION_TIMEOUT_MS): Promise<string | null> {
  try {
    const run = Bun.spawn([program, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const givingUp = setTimeout(() => endStuckRun(run), timeout);
    if ((await run.exited.finally(() => clearTimeout(givingUp))) !== 0) return null;
    return (await new Response(run.stdout).text()).trim().split("\n")[0]!;
  } catch {
    return null;
  }
}

export function claudeProgramLookUps(report: (program: ClaudeProgram) => void, versionTimeout = VERSION_TIMEOUT_MS) {
  let latest = 0;
  return async (configured: string) => {
    const lookUp = ++latest;
    const found = findClaudeProgram(configured);
    report({ configured, found, version: null });
    if (!found) return;
    const version = await versionOf(found, versionTimeout);
    if (lookUp === latest) report({ configured, found, version });
  };
}
