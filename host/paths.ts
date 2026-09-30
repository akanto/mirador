import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const MAX_COMPLETIONS = 30;

export function expandHome(path: string) {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
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
  const typedParent = prefix.endsWith("/") ? prefix : dirname(prefix);
  const partialName = prefix.endsWith("/") ? "" : basename(prefix);
  const entries = await readdir(expandHome(typedParent || "/"), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .filter((entry) => entry.name.startsWith(partialName) && (partialName.startsWith(".") || !entry.name.startsWith(".")))
    .map((entry) => `${typedParent.replace(/\/?$/, "/")}${entry.name}/`)
    .sort()
    .slice(0, MAX_COMPLETIONS);
}
