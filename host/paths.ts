import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MAX_COMPLETIONS = 30;

/** Windows takes either slash between a path's names; elsewhere a backslash is part of a name. */
const pathSeparators = (platform: NodeJS.Platform) => (platform === "win32" ? ["/", "\\"] : ["/"]);

/** The path up to its last separator, with it: the directory of the name being typed. */
export const parentOf = (path: string, platform = process.platform) =>
  path.slice(0, Math.max(...pathSeparators(platform).map((separator) => path.lastIndexOf(separator))) + 1);

export function expandHome(path: string, platform = process.platform) {
  if (path === "~") return homedir();
  return pathSeparators(platform).some((separator) => path.startsWith(`~${separator}`)) ? join(homedir(), path.slice(2)) : path;
}

export async function existingDirectory(path: string): Promise<string> {
  const absolute = resolve(expandHome(path.trim()));
  const info = await stat(absolute).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${absolute} is not a directory.`);
  return absolute.replace(/\/+$/, "") || "/";
}

/** Directories whose path starts with `prefix`, keeping the user's `~` spelling. */
export async function completeDirectories(typed: string): Promise<string[]> {
  const prefix = typed === "~" ? "~/" : typed || "/";
  const partialName = prefix.slice(parentOf(prefix).length);
  const typedParent = parentOf(prefix) || "./";
  const entries = await readdir(expandHome(typedParent), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .filter((entry) => entry.name.startsWith(partialName) && (partialName.startsWith(".") || !entry.name.startsWith(".")))
    .map((entry) => `${typedParent}${entry.name}/`)
    .sort()
    .slice(0, MAX_COMPLETIONS);
}
