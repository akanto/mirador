import { readdir, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import type { ChangeStatus } from "../shared/changes.ts";
import type { FileBefore } from "./edit-diff.ts";
import { LineCountCache } from "./line-count-cache.ts";

/** A file that differs between two of git's trees, or between a tree and the working tree. */
export interface TreeChange {
  path: string;
  status: ChangeStatus;
  /** Null for a binary file. */
  added: number | null;
  removed: number | null;
}

const SUBMODULE_MODE = "160000";
const MAX_FILE_BYTES = 1024 * 1024;
const LINE_COUNTS_KEPT = 20_000;
const FILES_HANDLED_AT_ONCE = 32;
const untrackedLineCounts = new LineCountCache(LINE_COUNTS_KEPT);

const statusOf = (letter: string): ChangeStatus => (letter === "A" ? "added" : letter === "D" ? "deleted" : "modified");
const countOf = (field: string | undefined) => (field === undefined || field === "-" ? null : Number(field));

/**
 * The files of git's `-z --raw --no-renames` output (":100644 100644 <old> <new> M", then the path, each ended by NUL)
 * with their line counts from `-z --numstat` ("<added>\t<removed>\t<path>", NUL-ended; "-" for a binary file). A
 * submodule's own files are its repository's, so a submodule is left out.
 */
export function treeChangesIn(raw: string, numstat: string): TreeChange[] {
  const counts = new Map(
    numstat
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const [added, removed, ...path] = entry.split("\t");
        return [path.join("\t"), { added: countOf(added), removed: countOf(removed) }] as const;
      }),
  );
  const fields = raw.split("\0").filter(Boolean);
  return fields.flatMap((field, index) => {
    if (index % 2 === 1) return [];
    const [fromMode, toMode, , , letter = ""] = field.slice(1).split(" ");
    const path = fields[index + 1] ?? "";
    if (fromMode === SUBMODULE_MODE || toMode === SUBMODULE_MODE) return [];
    return [{ path, status: statusOf(letter), ...(counts.get(path) ?? { added: null, removed: null }) }];
  });
}

const lineCount = (text: string) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

/** Read-only git: no optional locks, so it never rewrites the user's index while they or the agent use the repository. */
async function git(directory: string, args: string[], input = "") {
  const child = Bun.spawn(["git", "--no-optional-locks", "-C", directory, ...args], { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr: stderr.trim(), exitCode };
}

async function mustGit(directory: string, args: string[], input?: string) {
  const result = await git(directory, args, input);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${directory}: ${result.stderr}`);
  return result.stdout;
}

export const isRepository = async (directory: string) => (await git(directory, ["rev-parse", "--git-dir"])).exitCode === 0;

/** HEAD, or the empty tree in a repository with no commit yet, so its first files show as added. */
export async function headOrEmptyTree(directory: string) {
  const head = await git(directory, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return head.exitCode === 0 ? head.stdout.trim() : (await mustGit(directory, ["hash-object", "-t", "tree", "--stdin"])).trim();
}

/**
 * What `git status` would list against HEAD, with line counts: the tracked files that differ from HEAD (staged or
 * not), and the untracked files .gitignore does not hide. Null when the directory is not in a git repository.
 */
export async function uncommittedChanges(directory: string): Promise<TreeChange[] | null> {
  if (!(await isRepository(directory))) return null;
  const head = await headOrEmptyTree(directory);
  const diff = (format: string) => mustGit(directory, ["diff", "--relative", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", format, head]);
  const [raw, numstat, untracked] = await Promise.all([diff("--raw"), diff("--numstat"), mustGit(directory, ["ls-files", "--others", "--exclude-standard", "-z"])]);
  const added = await inLimitedParallel(untracked.split("\0").filter(Boolean), (path) => untrackedChange(directory, path));
  return [...treeChangesIn(raw, numstat), ...added];
}

async function untrackedChange(directory: string, path: string): Promise<TreeChange> {
  const fullPath = join(directory, path);
  const stats = await stat(fullPath).catch(() => null);
  const added = stats?.isFile() ? await untrackedLineCounts.countOf(fullPath, stats, () => addedLinesOf(fullPath, stats.size)) : null;
  return { path, status: "added", added, removed: added === null ? null : 0 };
}

async function addedLinesOf(fullPath: string, size: number) {
  if (size > MAX_FILE_BYTES) return null;
  const text = await Bun.file(fullPath).text().catch(() => null);
  return text === null || text.includes("\0") ? null : lineCount(text);
}

/** Like `Promise.all(items.map(work))`, with at most FILES_HANDLED_AT_ONCE under way, so thousands of files are not opened at once. The results keep the items' order. */
async function inLimitedParallel<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const waiting = items.entries();
  const workers = Array.from({ length: Math.min(FILES_HANDLED_AT_ONCE, items.length) }, async () => {
    for (const [index, item] of waiting) results[index] = await work(item);
  });
  await Promise.all(workers);
  return results;
}

const SCAN_SKIPS = new Set([".git", "node_modules", ".DS_Store"]);
const isOfficeLockFile = (name: string) => name.startsWith("~$");
export const MAX_SCANNED_FILES = 50_000;

/** The files under `directory`, relative to it with / as git writes them, skipping the folders nothing of the user's lives in; it stops after `limit` of them, and says so. */
async function scannedFiles(directory: string, limit: number) {
  const files: string[] = [];
  const pending = [""];
  for (let folder = pending.pop(); folder !== undefined && files.length <= limit; folder = pending.pop()) {
    const entries = await readdir(join(directory, folder), { withFileTypes: true }).catch(() => []);
    entries
      .filter(({ name }) => !SCAN_SKIPS.has(name) && !isOfficeLockFile(name))
      .forEach((entry) => (entry.isDirectory() ? pending.push(posix.join(folder, entry.name)) : entry.isFile() && files.push(posix.join(folder, entry.name))));
  }
  return { files: files.slice(0, limit), truncated: files.length > limit };
}

/** Not the change time: opening a file in Finder moves that, and a file made with an old modified time still has its birth. */
const writtenAt = (stats: { mtimeMs: number; birthtimeMs: number }) => Math.max(stats.mtimeMs, stats.birthtimeMs);

/**
 * The files of a folder that is not a git repository which were written at or after `since` (epoch ms), by their times
 * alone: a file made since then is added with its line counts, any other is modified. Nothing says what a file held
 * before, and a deleted file leaves nothing to find. A folder of more than `limit` files is checked only in part, which
 * `truncated` says.
 */
export async function filesWrittenSince(directory: string, since: number, limit = MAX_SCANNED_FILES): Promise<{ changes: TreeChange[]; truncated: boolean }> {
  const { files, truncated } = await scannedFiles(directory, limit);
  const written = await inLimitedParallel(files, async (path) => {
    const stats = await stat(join(directory, path)).catch(() => null);
    return stats && writtenAt(stats) >= since ? [{ path, createdSince: stats.birthtimeMs >= since }] : [];
  });
  const changes = await inLimitedParallel(written.flat(), async ({ path, createdSince }) =>
    createdSince ? untrackedChange(directory, path) : { path, status: "modified" as const, added: null, removed: null },
  );
  return { changes, truncated };
}

/** Whether the file was made at or after `since`, which the file's time of birth says where the system keeps one. */
export async function createdSince(directory: string, path: string, since: number) {
  return ((await stat(join(directory, path)).catch(() => null))?.birthtimeMs ?? 0) >= since;
}

/** A file as `revision` holds it: its text, or that it has no such file, or that it is binary or too large to show. */
export async function fileAtRevision(directory: string, revision: string, path: string): Promise<FileBefore> {
  const size = await git(directory, ["cat-file", "-s", `${revision}:./${path}`]);
  if (size.exitCode !== 0) return { kind: "missing" };
  if (Number(size.stdout) > MAX_FILE_BYTES) return { kind: "unreadable" };
  const text = await mustGit(directory, ["cat-file", "blob", `${revision}:./${path}`]);
  return text.includes("\0") ? { kind: "unreadable" } : { kind: "text", text };
}

