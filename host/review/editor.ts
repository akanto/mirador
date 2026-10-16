import { homedir } from "node:os";
import { delimiter, isAbsolute, join, normalize, sep } from "node:path";
import { currentPath } from "../current-path.ts";

/** Where IntelliJ IDEA's launcher script goes: Homebrew, "Create Command-line Launcher…", and JetBrains Toolbox. */
const IDEA_INSTALL_DIRECTORIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(homedir(), "Library", "Application Support", "JetBrains", "Toolbox", "scripts"),
  join(homedir(), ".local", "share", "JetBrains", "Toolbox", "scripts"),
];

export function openInIdea(repository: string, path: string, line: number) {
  const file = normalize(join(repository, path));
  if (isAbsolute(path) || !file.startsWith(repository + sep) || !Number.isInteger(line) || line < 1) {
    throw new Error(`${path}:${line} is not a line in the reviewed checkout.`);
  }
  launchIdea(file, line);
}

/** Opens an absolute path at a line in IntelliJ IDEA; the caller decides which files a page may open. */
export function launchIdea(file: string, line: number) {
  const executable = Bun.which("idea", { PATH: currentPath() }) ?? Bun.which("idea", { PATH: IDEA_INSTALL_DIRECTORIES.join(delimiter) });
  if (!executable) {
    throw new Error("IntelliJ IDEA's command-line launcher (idea) was not found. In IDEA, choose Tools › Create Command-line Launcher…, then try again.");
  }
  Bun.spawn([executable, "--line", String(line), file], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
}
