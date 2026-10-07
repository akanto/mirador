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
  await git(projectDir, ["init", "-q"]);
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

  expect((await git(projectDir, ["rev-parse", "--verify", "--quiet", `${second}^`])).exitCode).not.toBe(0);
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
