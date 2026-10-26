import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { currentPath } from "./current-path.ts";

/** Where IntelliJ IDEA's launcher script goes: Homebrew, "Create Command Line Launcher…", and JetBrains Toolbox. */
const IDEA_INSTALL_DIRECTORIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(homedir(), "Library", "Application Support", "JetBrains", "Toolbox", "scripts"),
  join(homedir(), ".local", "share", "JetBrains", "Toolbox", "scripts"),
];

/** How IDEA itself sets up its launcher on the host's platform. */
export const ideaLauncherMissing = (platform = process.platform) =>
  platform === "win32"
    ? 'IntelliJ IDEA\'s command-line launcher (idea) was not found on PATH. Tick Add "bin" folder to the PATH in IDEA\'s installer, or install IDEA with the Toolbox App, then try again.'
    : "IntelliJ IDEA's command-line launcher (idea) was not found. In IDEA, choose Tools › Create Command Line Launcher…, then try again.";

/** Opens an absolute path at a line in IntelliJ IDEA; the caller decides which files a page may open. */
export function launchIdea(file: string, line: number) {
  const executable = Bun.which("idea", { PATH: currentPath() }) ?? Bun.which("idea", { PATH: IDEA_INSTALL_DIRECTORIES.join(delimiter) });
  if (!executable) throw new Error(ideaLauncherMissing());
  Bun.spawn([executable, "--line", String(line), file], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
}
