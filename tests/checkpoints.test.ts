import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "../shared/model.ts";
import { Checkpoints } from "../host/checkpoints.ts";

let dataDir: string;
let projectDir: string;
let checkpoints: Checkpoints;
let workspace: Workspace;

async function git(directory: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", directory, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout: stdout.trim(), exitCode };
}

const write = (relative: string, content: string) => writeFile(join(projectDir, relative), content);
const read = (relative: string) => readFile(join(projectDir, relative), "utf8");

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "mirador-checkpoints-"));
  projectDir = join(dataDir, "project");
  await mkdir(projectDir);
  await git(projectDir, ["-c", "init.defaultBranch=main", "init", "-q"]);
  await write(".gitignore", "build\n");
  await write("kept.txt", "one\n");
  await write("doomed.txt", "doomed\n");
  await git(projectDir, ["add", "-A"]);
  await git(projectDir, ["commit", "-qm", "base"]);
  checkpoints = new Checkpoints(dataDir);
  workspace = { id: "ws-1", name: "project", path: projectDir, defaultLaunch: { harness: "claude", profileId: null }, color: null, position: 0, groupId: null, createdAt: 0 };
});

afterEach(() => rm(dataDir, { recursive: true, force: true }));

test("a restore puts back what a turn changed, deletes what it created, and says how many of each", async () => {
  const snapshot = await checkpoints.snapshot(workspace);
  expect(snapshot).toMatch(/^[0-9a-f]{40}$/);

  await write("kept.txt", "changed by the agent\n");
  await write("added.txt", "new\n");
  await rm(join(projectDir, "doomed.txt"));

  expect(await checkpoints.preview(workspace, snapshot!)).toEqual({ restored: 2, removed: 1 });
  expect(await checkpoints.restore(workspace, snapshot!)).toEqual({ restored: 2, removed: 1 });
  expect(await read("kept.txt")).toBe("one\n");
  expect(await read("doomed.txt")).toBe("doomed\n");
  await expect(read("added.txt")).rejects.toThrow();
});

test("a restore puts files back with the line endings they had, even where core.autocrlf would convert them", async () => {
  await git(projectDir, ["config", "core.autocrlf", "true"]);
  await write("unix.txt", "lf\n");
  await write("windows.txt", "crlf\r\n");
  await write("mixed.txt", "lf\ncrlf\r\n");
  const before = await git(projectDir, ["status", "--porcelain"]);
  const snapshot = (await checkpoints.snapshot(workspace))!;

  await Promise.all(["kept.txt", "unix.txt", "windows.txt", "mixed.txt"].map((file) => write(file, "changed by the agent\n")));
  await checkpoints.restore(workspace, snapshot);

  expect(await read("kept.txt")).toBe("one\n");
  expect(await read("unix.txt")).toBe("lf\n");
  expect(await read("windows.txt")).toBe("crlf\r\n");
  expect(await read("mixed.txt")).toBe("lf\ncrlf\r\n");
  expect((await git(projectDir, ["status", "--porcelain"])).stdout).toBe(before.stdout);
});

test("a restored folder holds only what the snapshot had, and the folder a deleted file made is gone with it", async () => {
  await mkdir(join(projectDir, "src"));
  await write("src/deep.txt", "deep\n");
  const snapshot = (await checkpoints.snapshot(workspace))!;
  await git(projectDir, ["add", "-A"]);

  await rm(join(projectDir, "src"), { recursive: true });
  await checkpoints.restore(workspace, snapshot);
  expect(await read("src/deep.txt")).toBe("deep\n");

  await rm(join(projectDir, "src", "deep.txt"));
  await checkpoints.restore(workspace, snapshot);
  expect(await read("src/deep.txt")).toBe("deep\n");
});

test("what the user's repository shows is untouched: same branch, same log, same staged changes", async () => {
  await write("staged.txt", "staged\n");
  await git(projectDir, ["add", "staged.txt"]);
  const before = await git(projectDir, ["status", "--porcelain"]);
  const head = (await git(projectDir, ["rev-parse", "HEAD"])).stdout;

  const snapshot = (await checkpoints.snapshot(workspace))!;
  await write("kept.txt", "agent\n");
  await checkpoints.restore(workspace, snapshot);

  expect((await git(projectDir, ["rev-parse", "HEAD"])).stdout).toBe(head);
  expect((await git(projectDir, ["log", "--oneline"])).stdout.split("\n")).toHaveLength(1);
  expect((await git(projectDir, ["branch", "--show-current"])).stdout).toBe("main");
  expect((await git(projectDir, ["status", "--porcelain"])).stdout).toBe(before.stdout);
});

const status = async () => (await git(projectDir, ["status", "--porcelain"])).stdout;
const stagedPaths = async () => (await git(projectDir, ["diff", "--cached", "--name-only"])).stdout.split("\n").filter(Boolean);
const stagedVersionOf = async (relative: string) => (await git(projectDir, ["show", `:${relative}`])).stdout;

test("what the agent staged during the turn is unstaged by a restore, and what the user staged before it is staged again", async () => {
  await write("kept.txt", "staged by the user\n");
  await git(projectDir, ["add", "kept.txt"]);
  const snapshot = (await checkpoints.snapshot(workspace))!;

  await write("kept.txt", "staged by the agent\n");
  await write("doomed.txt", "staged by the agent too\n");
  await write("added.txt", "new, staged by the agent\n");
  await git(projectDir, ["add", "-A"]);
  await checkpoints.restore(workspace, snapshot);

  expect(await read("kept.txt")).toBe("staged by the user\n");
  expect(await stagedPaths()).toEqual(["kept.txt"]);
  expect(await stagedVersionOf("kept.txt")).toBe("staged by the user");
});

test("after a commit since the snapshot, a restore unstages what differs rather than stage a revert of the commit", async () => {
  const snapshot = (await checkpoints.snapshot(workspace))!;
  await write("kept.txt", "committed by the agent\n");
  await git(projectDir, ["commit", "-qam", "the agent's commit"]);

  await checkpoints.restore(workspace, snapshot);

  expect(await read("kept.txt")).toBe("one\n");
  expect(await stagedPaths()).toEqual([]);
});

test("a restore that writes no file leaves the staging as it is", async () => {
  await write("kept.txt", "the user's change\n");
  const snapshot = (await checkpoints.snapshot(workspace))!;
  await git(projectDir, ["add", "kept.txt"]);

  expect(await checkpoints.restore(workspace, snapshot)).toEqual({ restored: 0, removed: 0 });
  expect(await stagedPaths()).toEqual(["kept.txt"]);
});

test("a snapshot taken during a merge conflict still works, and its restore unstages what the agent staged", async () => {
  await git(projectDir, ["checkout", "-qb", "theirs"]);
  await write("doomed.txt", "theirs\n");
  await git(projectDir, ["commit", "-qam", "theirs"]);
  await git(projectDir, ["checkout", "-q", "main"]);
  await write("doomed.txt", "ours\n");
  await git(projectDir, ["commit", "-qam", "ours"]);
  await git(projectDir, ["merge", "-q", "theirs"]);
  const conflictStatus = await status();
  const snapshot = await checkpoints.snapshot(workspace);
  expect(snapshot).toMatch(/^[0-9a-f]{40}$/);

  await write("kept.txt", "staged by the agent\n");
  await git(projectDir, ["add", "kept.txt"]);
  await checkpoints.restore(workspace, snapshot!);

  expect(await status()).toBe(conflictStatus);
});

test("a snapshot from before staging was kept, even one chained to an older one, unstages the files a restore puts back whose staged version differs", async () => {
  const snapshotOfTheFiles = async (parents: string[] = []) => {
    await git(projectDir, ["add", "-A"]);
    const tree = (await git(projectDir, ["write-tree"])).stdout;
    return (await git(projectDir, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", "mirador: the files at the start of a turn"])).stdout;
  };
  await write("kept.txt", "an older turn\n");
  const older = await snapshotOfTheFiles();
  await write("kept.txt", "staged by the user\n");
  const snapshot = await snapshotOfTheFiles([older]);

  await write("kept.txt", "staged by the agent\n");
  await git(projectDir, ["add", "kept.txt"]);
  await write("doomed.txt", "changed by the agent, not staged\n");
  await checkpoints.restore(workspace, snapshot);

  expect(await read("kept.txt")).toBe("staged by the user\n");
  expect(await stagedPaths()).toEqual([]);
});

test("in a folder below the repository's top, a restore puts back and deletes the folder's own files and leaves the rest of the repository as it is", async () => {
  await mkdir(join(projectDir, "sub"));
  await write("sub/inner.txt", "inner\n");
  await write("sub/notes.md", "the folder's notes\n");
  await git(projectDir, ["add", "-A"]);
  await git(projectDir, ["commit", "-qm", "sub"]);
  const folder = { ...workspace, path: join(projectDir, "sub") };
  const snapshot = (await checkpoints.snapshot(folder))!;

  await write("sub/inner.txt", "changed by the agent\n");
  await write("sub/added.txt", "new\n");
  await write("notes.md", "notes at the top\n");
  await write("kept.txt", "the user's own change\n");
  await git(projectDir, ["add", "-A"]);

  expect(await checkpoints.preview(folder, snapshot)).toEqual({ restored: 1, removed: 1 });
  expect(await checkpoints.restore(folder, snapshot)).toEqual({ restored: 1, removed: 1 });
  expect(await read("sub/inner.txt")).toBe("inner\n");
  await expect(read("sub/added.txt")).rejects.toThrow();
  expect(await read("sub/notes.md")).toBe("the folder's notes\n");
  expect(await read("notes.md")).toBe("notes at the top\n");
  expect(await read("kept.txt")).toBe("the user's own change\n");
  expect(await stagedPaths()).toEqual(["kept.txt", "notes.md"]);
});

test("ignored files are neither stored nor deleted by a restore", async () => {
  const snapshot = (await checkpoints.snapshot(workspace))!;
  await mkdir(join(projectDir, "build"));
  await write("build/output.txt", "output\n");

  expect(await checkpoints.restore(workspace, snapshot)).toEqual({ restored: 0, removed: 0 });
  expect(await read("build/output.txt")).toBe("output\n");
});

const snapshotRefs = async () => (await git(projectDir, ["for-each-ref", "--format=%(objectname)", "refs/mirador/"])).stdout.split("\n").filter(Boolean);

test("each snapshot stands on its own, and only the newest are kept", async () => {
  const keepingTwo = new Checkpoints(dataDir, 2);
  const first = (await keepingTwo.snapshot(workspace))!;
  await write("kept.txt", "second\n");
  const second = (await keepingTwo.snapshot(workspace))!;
  await write("kept.txt", "third\n");
  const third = (await keepingTwo.snapshot(workspace))!;

  expect((await git(projectDir, ["rev-list", second])).stdout).not.toContain(first);
  expect((await snapshotRefs()).sort()).toEqual([second, third].sort());
  await git(projectDir, ["gc", "--quiet", "--prune=now"]);
  expect(await keepingTwo.keeps(workspace, first)).toBe(false);
  expect(await keepingTwo.keeps(workspace, second)).toBe(true);
});

test("the chain snapshots made before each had a ref is kept as one, and goes when it is the oldest", async () => {
  const tree = (await git(projectDir, ["write-tree"])).stdout;
  const older = (await git(projectDir, ["commit-tree", tree, "-m", "older"])).stdout;
  const chained = (await git(projectDir, ["commit-tree", tree, "-p", older, "-m", "newer"])).stdout;
  await git(projectDir, ["update-ref", "refs/mirador/ws-1", chained]);
  const keepingTwo = new Checkpoints(dataDir, 2);

  const first = (await keepingTwo.snapshot(workspace))!;
  expect((await snapshotRefs()).sort()).toEqual([chained, first].sort());
  expect(await keepingTwo.keeps(workspace, older)).toBe(true);

  await write("kept.txt", "second\n");
  const second = (await keepingTwo.snapshot(workspace))!;
  expect((await snapshotRefs()).sort()).toEqual([first, second].sort());
});

test("a submodule that moved is left as it is, and counted apart from the files", async () => {
  const library = join(dataDir, "library");
  await mkdir(library);
  await git(library, ["init", "-q"]);
  await writeFile(join(library, "lib.txt"), "v1\n");
  await git(library, ["add", "-A"]);
  await git(library, ["commit", "-qm", "v1"]);
  await git(projectDir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "library"]);
  await git(projectDir, ["commit", "-qam", "with the library"]);
  const snapshot = (await checkpoints.snapshot(workspace))!;

  await writeFile(join(projectDir, "library", "lib.txt"), "v2\n");
  await git(join(projectDir, "library"), ["commit", "-qam", "v2"]);
  await write("kept.txt", "changed\n");

  expect(await checkpoints.preview(workspace, snapshot)).toEqual({ restored: 1, removed: 0, submodulesLeft: 1 });
  expect(await checkpoints.restore(workspace, snapshot)).toEqual({ restored: 1, removed: 0, submodulesLeft: 1 });
  expect(await read("kept.txt")).toBe("one\n");
  expect(await readFile(join(projectDir, "library", "lib.txt"), "utf8")).toBe("v2\n");
});

test("a workspace that is not a git repository has no snapshots to restore", async () => {
  const plain = join(dataDir, "plain");
  await mkdir(plain);
  const elsewhere = { ...workspace, id: "ws-2", path: plain };

  expect(await checkpoints.snapshot(elsewhere)).toBeNull();
  expect(await checkpoints.preview(elsewhere, "0".repeat(40))).toBeNull();
});
