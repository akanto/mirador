import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Subprocess } from "bun";
import type { ClaudeProgram } from "../../shared/model.ts";
import { currentPath } from "../current-path.ts";
import { expandHome } from "../paths.ts";
import { killProcessTree } from "../windows-processes.ts";

/** Where Claude Code's installers put it (native, Homebrew, npm), for hosts started without a login shell's PATH. */
const claudeInstallDirectories = () =>
  process.platform === "win32" ? [join(homedir(), ".local", "bin")] : [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];

/** Where the host looks for claude after PATH, and how Claude Code is installed there, as the host's platform has it. */
export const claudeInstall = (platform = process.platform): Pick<ClaudeProgram, "installFolders" | "installCommand"> =>
  platform === "win32"
    ? { installFolders: "%USERPROFILE%\\.local\\bin", installCommand: "irm https://claude.ai/install.ps1 | iex" }
    : { installFolders: "~/.local/bin, /opt/homebrew/bin or /usr/local/bin", installCommand: "curl -fsSL https://claude.ai/install.sh | bash" };

export function claudeProgramMissing(configured: string, platform = process.platform) {
  if (configured) return `The Claude Code program set in Settings › Agents, ${configured}, does not exist or cannot run.`;
  const { installFolders, installCommand } = claudeInstall(platform);
  return `Claude Code is not installed: no claude on PATH or in ${installFolders}. Install it with \`${installCommand}\`, or set its path in Settings › Agents.`;
}

/** What Settings shows of the Claude Code the host runs. */
export const claudeProgramReport = (configured: string, found: string | null, version: string | null): ClaudeProgram => ({ configured, found, version, ...claudeInstall() });

/** The Claude Code this computer has: the program set in Settings, else the claude on PATH or in an installer's directory. */
export function findClaudeProgram(configured: string, path = currentPath()): string | null {
  if (configured) return Bun.which(expandHome(configured));
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
    report(claudeProgramReport(configured, found, null));
    if (!found) return;
    const version = await versionOf(found, versionTimeout);
    if (lookUp === latest) report(claudeProgramReport(configured, found, version));
  };
}
