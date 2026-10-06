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
  workspace = { id: "ws-1", name: "project", path: projectDir, defaultLaunch: { harness: "claude", profileId: null }, color: null, position: 0, createdAt: 0 };
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

test("each snapshot hangs off the one before it, and the ref follows the newest", async () => {
  const first = (await checkpoints.snapshot(workspace))!;
  await write("kept.txt", "second\n");
  const second = (await checkpoints.snapshot(workspace))!;

  expect(second).not.toBe(first);
  expect((await git(projectDir, ["rev-parse", `${second}^`])).stdout).toBe(first);
  expect((await git(projectDir, ["rev-parse", "refs/mirador/ws-1"])).stdout).toBe(second);
});

test("a workspace that is not a git repository has no snapshots to restore", async () => {
  const plain = join(dataDir, "plain");
  await mkdir(plain);
  const elsewhere = { ...workspace, id: "ws-2", path: plain };

  expect(await checkpoints.snapshot(elsewhere)).toBeNull();
  expect(await checkpoints.preview(elsewhere, "0".repeat(40))).toBeNull();
});
