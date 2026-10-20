import { afterEach, beforeEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolKind } from "@agentclientprotocol/sdk";
import { agentEditsIn, Changes, OutsideWorkspace } from "../host/changes.ts";
import { Checkpoints } from "../host/checkpoints.ts";
import { Store } from "../host/store.ts";
import { createdSince, filesWrittenSince, ignoredFilesWrittenSince, treeChangesIn, uncommittedChanges } from "../host/working-tree.ts";
import type { StoredEvent } from "../shared/model.ts";
import { changesRefreshPoint, firstChangedLine } from "../web/changes.ts";

let root: string;
let projectDir: string;
let outsideDir: string;
let store: Store;
let checkpoints: Checkpoints;
let opened: { file: string; line: number }[];
let openedByDefault: string[];
let openedAsText: string[];
let defaultProgramOpens: boolean;
let textEditorOpens: boolean;
let changes: Changes;

/** Notes each file it is given, and opens it when the program it stands for would. */
const openerNoting = (openedFiles: string[], programOpens: () => boolean) => async (file: string) => {
  openedFiles.push(file);
  return programOpens();
};

async function git(directory: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", directory, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

const write = (relative: string, content: string) => writeFile(join(projectDir, relative), content);

const workspace = () => store.listWorkspaces()[0]!;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mirador-changes-")));
  projectDir = join(root, "project");
  outsideDir = join(root, "elsewhere");
  await mkdir(projectDir);
  await mkdir(outsideDir);
  await git(projectDir, ["init", "-q"]);
  await write(".gitignore", "build\n");
  await write("kept.txt", "one\ntwo\nthree\n");
  await write("doomed.txt", "doomed\n");
  await git(projectDir, ["add", "-A"]);
  await git(projectDir, ["commit", "-qm", "base"]);
  store = new Store(":memory:");
  store.insertWorkspace({ id: "w1", name: "project", path: projectDir, defaultLaunch: { harness: "claude", profileId: null }, createdAt: 1 });
  store.insertConversation({
    id: "c1",
    workspaceId: "w1",
    harness: "claude",
    profileId: null,
    title: "t",
    titleSetByUser: false,
    acpSessionId: null,
    askMode: "wait",
    bypassPermissions: false,
    status: "idle",
    statusDetail: null,
    openInTerminal: null,
    contextUsage: null,
    queuedMessages: [],
    usageLimit: null,
    jobWaits: [],
    asyncTasks: [],
    waitingFor: null,
    pendingRequest: null,
    lastWords: null,
    activity: null,
    configOptions: [],
    createdAt: 1,
    updatedAt: 1,
  });
  checkpoints = new Checkpoints(root);
  opened = [];
  openedByDefault = [];
  openedAsText = [];
  defaultProgramOpens = true;
  textEditorOpens = true;
  changes = new Changes(
    store,
    checkpoints,
    () => workspace(),
    (file, line) => opened.push({ file, line }),
    openerNoting(openedByDefault, () => defaultProgramOpens),
    openerNoting(openedAsText, () => textEditorOpens),
  );
});

afterEach(() => rm(root, { recursive: true, force: true }));

async function startTurn() {
  const checkpoint = await checkpoints.snapshot(workspace());
  return store.appendEvent("c1", { type: "user-message", text: "go", ...(checkpoint && { checkpoint }) });
}

/** A finished edit as Claude Code reports it: the kind first, then the path and diff, then done. */
function agentEdits(toolCallId: string, path: string, oldText: string | null, newText: string, kind: ToolKind = "edit") {
  store.appendEvent("c1", { type: "acp", update: { sessionUpdate: "tool_call", toolCallId, title: "Edit", kind, status: "pending" } });
  store.appendEvent("c1", {
    type: "acp",
    update: { sessionUpdate: "tool_call_update", toolCallId, locations: [{ path }], content: [{ type: "diff", path, oldText, newText }] },
  });
  store.appendEvent("c1", { type: "acp", update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" } });
}

test("git's raw and numstat output give each file's status and line counts, with binaries uncounted and submodules left out", () => {
  const raw = [":100644 100644 aaa bbb M", "src/a b.ts", ":000000 100644 000 ccc A", "logo.png", ":160000 160000 ddd eee M", "vendor/lib", ":100644 000000 fff 000 D", "gone.txt", ""].join("\0");
  const numstat = ["3\t1\tsrc/a b.ts", "-\t-\tlogo.png", "1\t1\tvendor/lib", "0\t2\tgone.txt", ""].join("\0");
  expect(treeChangesIn(raw, numstat)).toEqual([
    { path: "src/a b.ts", status: "modified", added: 3, removed: 1 },
    { path: "logo.png", status: "added", added: null, removed: null },
    { path: "gone.txt", status: "deleted", added: 0, removed: 2 },
  ]);
});

test("uncommitted changes are git status against HEAD, staged or not, with untracked files and without ignored ones", async () => {
  await write("kept.txt", "one\ntwo\nthree\nfour\n");
  await write("new.txt", "a\nb\n");
  await mkdir(join(projectDir, "build"));
  await write("build/out.js", "ignored\n");
  await rm(join(projectDir, "doomed.txt"));
  await git(projectDir, ["add", "kept.txt"]);

  expect(await uncommittedChanges(projectDir)).toEqual([
    { path: "doomed.txt", status: "deleted", added: 0, removed: 1 },
    { path: "kept.txt", status: "modified", added: 1, removed: 0 },
    { path: "new.txt", status: "added", added: 2, removed: 0 },
  ]);
});

test("in a folder below the repository's top, paths are the folder's own and files elsewhere in the repository are left out", async () => {
  await mkdir(join(projectDir, "sub"));
  await write("sub/inner.txt", "inner\n");
  await git(projectDir, ["add", "-A"]);
  await git(projectDir, ["commit", "-qm", "sub"]);
  await write("sub/inner.txt", "inner\nmore\n");
  await write("kept.txt", "changed\n");

  expect(await uncommittedChanges(join(projectDir, "sub"))).toEqual([{ path: "inner.txt", status: "modified", added: 1, removed: 0 }]);
});

test("the agent's edits come from its finished edit tool calls, each file with the last and fullest diff of each call", () => {
  agentEdits("t1", "/p/a.ts", "x", "y");
  store.appendEvent("c1", { type: "acp", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", content: [{ type: "diff", path: "/p/a.ts", oldText: "x\nz", newText: "y\nz" }] } });
  store.appendEvent("c1", { type: "acp", update: { sessionUpdate: "tool_call", toolCallId: "t2", title: "Read", kind: "read", status: "pending", locations: [{ path: "/p/read.ts" }] } });
  store.appendEvent("c1", { type: "acp", update: { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed" } });
  store.appendEvent("c1", { type: "acp", update: { sessionUpdate: "tool_call", toolCallId: "t3", title: "Edit", kind: "edit", status: "pending" } });
  store.appendEvent("c1", { type: "acp", update: { sessionUpdate: "tool_call_update", toolCallId: "t3", locations: [{ path: "/p/rejected.ts" }], status: "failed" } });
  agentEdits("t4", "/p/a.ts", "y", "w");

  expect(agentEditsIn(store.toolCallEventsFrom("c1", 0))).toEqual([
    {
      path: "/p/a.ts",
      deleted: false,
      snippets: [
        { oldText: "x\nz", newText: "y\nz" },
        { oldText: "y", newText: "w" },
      ],
    },
  ]);
});

test("this turn lists what differs from the turn's start, marks the agent's files, and keeps files outside the project apart", async () => {
  await write("kept.txt", "one\nTWO\nthree\n");
  await startTurn();
  await write("kept.txt", "one\nTWO\nthree\nfour\n");
  agentEdits("t1", join(projectDir, "kept.txt"), "three\n", "three\nfour\n");
  await write("by-hand.txt", "typed\n");
  await writeFile(join(outsideDir, "notes.md"), "outside\n");
  agentEdits("t2", join(outsideDir, "notes.md"), null, "outside\n");

  const list = await changes.list("c1", "turn");
  expect(list.base).toBe("turn-start");
  expect(list.project).toEqual([
    { path: "by-hand.txt", status: "added", added: 1, removed: 0, byAgent: false },
    { path: "kept.txt", status: "modified", added: 1, removed: 0, byAgent: true },
  ]);
  expect(list.outside).toEqual([{ path: join(outsideDir, "notes.md"), status: "modified", added: null, removed: null, byAgent: true }]);

  const uncommitted = await changes.list("c1", "uncommitted");
  expect(uncommitted.base).toBe("head");
  expect(uncommitted.project.map(({ path, added, removed }) => [path, added, removed])).toEqual([
    ["by-hand.txt", 1, 0],
    ["kept.txt", 2, 1],
  ]);
});

test("this turn lists the files commits since the turn began changed apart, the agent's own commit still marked, and their diffs from the turn's start", async () => {
  await startTurn();
  await write("pulled.txt", "from a pull\n");
  await git(projectDir, ["add", "pulled.txt"]);
  await git(projectDir, ["commit", "-qm", "pulled"]);
  await write("kept.txt", "one\nTWO\nthree\n");
  agentEdits("t1", join(projectDir, "kept.txt"), "two\n", "TWO\n");
  await git(projectDir, ["commit", "-qam", "the agent's"]);
  await write("doomed.txt", "edited since\n");

  const list = await changes.list("c1", "turn");
  expect(list.project).toEqual([{ path: "doomed.txt", status: "modified", added: 1, removed: 1, byAgent: false }]);
  expect(list.committed).toEqual([
    { path: "kept.txt", status: "modified", added: 1, removed: 1, byAgent: true },
    { path: "pulled.txt", status: "added", added: 1, removed: 0, byAgent: false },
  ]);
  expect((await changes.diff("c1", "turn", "kept.txt")).source).toBe("files");
  expect((await changes.list("c1", "uncommitted")).committed).toEqual([]);
});

test("a new turn starts with an empty list, and edits of an earlier turn stay under uncommitted", async () => {
  await startTurn();
  await write("kept.txt", "changed\n");
  agentEdits("t1", join(projectDir, "kept.txt"), "one\ntwo\nthree\n", "changed\n");
  await startTurn();

  expect((await changes.list("c1", "turn")).project).toEqual([]);
  expect((await changes.list("c1", "uncommitted")).project).toEqual([{ path: "kept.txt", status: "modified", added: 1, removed: 3, byAgent: true }]);
});

test("a path the agent gives relative to the workspace counts as the project's file", async () => {
  await startTurn();
  await write("kept.txt", "changed\n");
  agentEdits("t1", "kept.txt", "one\ntwo\nthree\n", "changed\n");

  const list = await changes.list("c1", "turn");
  expect(list.project).toEqual([{ path: "kept.txt", status: "modified", added: 1, removed: 3, byAgent: true }]);
  expect(list.outside).toEqual([]);
});

test("a file the agent edits in a folder is listed once, by the path git gives it, as the agent's, in a repository or not", async () => {
  await mkdir(join(projectDir, "src"));
  await startTurn();
  await Bun.sleep(20);
  await write("src/app.ts", "one\n");
  agentEdits("t1", join(projectDir, "src", "app.ts"), null, "one\n");

  expect((await changes.list("c1", "turn")).project).toEqual([{ path: "src/app.ts", status: "added", added: 1, removed: 0, byAgent: true }]);
  await leaveGit();
  expect((await changes.list("c1", "turn")).project).toEqual([{ path: "src/app.ts", status: "added", added: 1, removed: 0, byAgent: true }]);
  expect((await changes.diff("c1", "turn", "src/app.ts")).source).toBe("agent");
});

test("before the first turn there is nothing to list for this turn", async () => {
  expect(await changes.list("c1", "turn")).toEqual({ scope: "turn", base: "no-turn", project: [], committed: [], outside: [] });
});

test("a file's diff has the file's line numbers against the turn's start, and against HEAD for uncommitted", async () => {
  await write("kept.txt", "one\nTWO\nthree\n");
  await startTurn();
  await write("kept.txt", "one\nTWO\nthree\nfour\n");

  const turn = await changes.diff("c1", "turn", "kept.txt");
  expect(turn.source).toBe("files");
  const rows = turn.diffs[0]!.hunks.flatMap((hunk) => hunk.rows);
  expect(rows.filter(({ kind }) => kind !== "context")).toEqual([{ kind: "added", oldLine: null, newLine: 4, text: "four" }]);
  expect(firstChangedLine(turn)).toBe(4);

  const uncommitted = await changes.diff("c1", "uncommitted", "kept.txt");
  expect(uncommitted.diffs[0]!.hunks.flatMap((hunk) => hunk.rows).filter(({ kind }) => kind !== "context")).toEqual([
    { kind: "removed", oldLine: 2, newLine: null, text: "two" },
    { kind: "added", oldLine: null, newLine: 2, text: "TWO" },
    { kind: "added", oldLine: null, newLine: 4, text: "four" },
  ]);
  expect(firstChangedLine(uncommitted)).toBe(2);
});

test("a deleted file's diff shows all its lines removed", async () => {
  await rm(join(projectDir, "doomed.txt"));
  const diff = await changes.diff("c1", "uncommitted", "doomed.txt");
  expect(diff.diffs[0]).toMatchObject({ change: "deleted", added: 0, removed: 1 });
});

test("a file outside the project shows only the agent's own snippets, and one it did not edit is refused", async () => {
  await startTurn();
  const notes = join(outsideDir, "notes.md");
  await writeFile(notes, "on disk, never read\n");
  agentEdits("t1", notes, "old line", "new line");

  const diff = await changes.diff("c1", "turn", notes);
  expect(diff.source).toBe("agent");
  expect(diff.diffs.map((each) => each.hunks.flatMap((hunk) => hunk.rows).map(({ kind, text }) => [kind, text]))).toEqual([
    [
      ["removed", "old line"],
      ["added", "new line"],
    ],
  ]);
  expect(firstChangedLine(diff)).toBe(1);
  await expect(changes.diff("c1", "turn", "/etc/hosts")).rejects.toThrow("did not change");
});

test("a page can name only the project's files, or a file the agent edited, to show or open", async () => {
  await startTurn();
  const notes = join(outsideDir, "notes.md");
  agentEdits("t1", notes, null, "x");

  await expect(changes.diff("c1", "turn", "../elsewhere/notes.md")).rejects.toThrow("not a file of this workspace");
  await expect(changes.diff("c1", "uncommitted", "../../etc/hosts")).rejects.toThrow("not a file of this workspace");
  await expect(changes.openInEditor("c1", "/etc/hosts", 1)).rejects.toThrow("did not change");
  await expect(changes.openInEditor("c1", "../elsewhere/notes.md", 1)).rejects.toThrow("not a file of this workspace");
  await expect(changes.openInEditor("c1", "kept.txt", 0)).rejects.toThrow("not a line number");

  await changes.openInEditor("c1", "kept.txt", 3);
  await changes.openInEditor("c1", notes, 1);
  expect(opened).toEqual([
    { file: join(projectDir, "kept.txt"), line: 3 },
    { file: notes, line: 1 },
  ]);
});

async function leaveGit() {
  await rm(join(projectDir, ".git"), { recursive: true });
  const longAgo = new Date(Date.now() - 60_000);
  await Promise.all(["kept.txt", "doomed.txt", ".gitignore"].map((file) => utimes(join(projectDir, file), longAgo, longAgo)));
  await Bun.sleep(50);
}

test("outside a git repository, the uncommitted list and its diffs are the agent's own edits", async () => {
  await leaveGit();
  await startTurn();
  agentEdits("t1", join(projectDir, "kept.txt"), "two", "TWO");

  expect(await changes.list("c1", "uncommitted")).toMatchObject({ base: "not-a-repository", project: [{ path: "kept.txt", status: "modified", added: null, byAgent: true }] });
  expect((await changes.diff("c1", "uncommitted", "kept.txt")).source).toBe("agent");
});

test("outside a git repository, a turn lists the files written since it began, a script's included", async () => {
  await leaveGit();
  await startTurn();
  await Bun.sleep(20);
  await mkdir(join(projectDir, "out"));
  await write("out/report.txt", "a\nb\n");
  await write("doomed.txt", "rewritten by a script\n");
  agentEdits("t1", join(projectDir, "kept.txt"), "two", "TWO");

  const list = await changes.list("c1", "turn");
  expect(list.base).toBe("turn-file-times");
  expect(list.project).toEqual([
    { path: "doomed.txt", status: "modified", added: null, removed: null, byAgent: false },
    { path: "kept.txt", status: "modified", added: null, removed: null, byAgent: true },
    { path: "out/report.txt", status: "added", added: 2, removed: 0, byAgent: false },
  ]);

  expect((await changes.diff("c1", "turn", "kept.txt")).source).toBe("agent");
  const created = await changes.diff("c1", "turn", "out/report.txt");
  expect(created.diffs[0]).toMatchObject({ change: "added", added: 2 });
  expect((await changes.diff("c1", "turn", "doomed.txt")).diffs[0]).toMatchObject({ hiddenBecause: expect.stringContaining("no earlier version") });
});

test("the Changes view loads again after finished tool calls, turns, the user's commands and undos, and not on streamed text", () => {
  const events = (...each: StoredEvent["event"][]): StoredEvent[] => each.map((event, index) => ({ seq: index + 1, at: 0, event }));
  const chunk: StoredEvent["event"] = { type: "acp", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } };
  const finished: StoredEvent["event"] = { type: "acp", update: { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" } };
  const running: StoredEvent["event"] = { type: "acp", update: { sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress" } };

  expect(changesRefreshPoint(events({ type: "user-message", text: "go" }, chunk, running))).toBe(1);
  expect(changesRefreshPoint(events({ type: "user-message", text: "go" }, finished, chunk))).toBe(2);
  expect(changesRefreshPoint(events(chunk, { type: "turn-end", stopReason: "end_turn" }))).toBe(2);
  expect(changesRefreshPoint(events(chunk))).toBe(0);
});

test("a folder of more files than the limit is checked in part, and says so", async () => {
  await leaveGit();
  await Promise.all(["a", "b", "c", "d"].map((name) => write(`${name}.txt`, `${name}\n`)));
  const everythingSinceEver = 0;

  const whole = await filesWrittenSince(projectDir, everythingSinceEver, 100);
  expect(whole.truncated).toBe(false);
  expect(whole.changes).toHaveLength(7);

  const part = await filesWrittenSince(projectDir, everythingSinceEver, 3);
  expect(part.truncated).toBe(true);
  expect(part.changes).toHaveLength(3);
});

test("ignored files written since a timestamp are found, while unignored and older ones are not", async () => {
  await mkdir(join(projectDir, "build"));
  await write("build/output.log", "line 1\nline 2\n");
  await write("untracked.txt", "untracked\n");
  const now = Date.now();
  const past = now - 60_000;
  const future = now + 60_000;

  const found = await ignoredFilesWrittenSince(projectDir, past);
  expect(found.changes).toEqual([{ path: "build/output.log", status: "added", added: 2, removed: 0 }]);
  expect(found.truncated).toBe(false);

  const none = await ignoredFilesWrittenSince(projectDir, future);
  expect(none.changes).toEqual([]);

  const part = await ignoredFilesWrittenSince(projectDir, past, 0);
  expect(part.truncated).toBe(true);
  expect(part.changes).toHaveLength(0);
});

const aMomentAgo = () => Date.now() - 60_000;

async function writeIgnored(...paths: string[]) {
  await write(".gitignore", "build\ndist\nnode_modules\n*.log\n");
  await Promise.all(
    paths.map(async (path) => {
      await mkdir(dirname(join(projectDir, path)), { recursive: true });
      await write(path, `${path}\n`);
    }),
  );
}

test("ignored files deep in a hidden folder and beside tracked ones are found, but not under node_modules or tool folders", async () => {
  await writeIgnored("build/deep/er/output.js", "build/node_modules/pkg/index.js", "build/.beads/state.json", "node_modules/pkg/index.js", "src/trace.log");

  const found = await ignoredFilesWrittenSince(projectDir, aMomentAgo());

  expect(found.changes.map(({ path }) => path).sort()).toEqual(["build/deep/er/output.js", "src/trace.log"]);
  expect(found.truncated).toBe(false);
});

test("a repository of its own inside a hidden folder is left to that repository", async () => {
  await writeIgnored("build/output.js", "build/vendored/lib.js");
  await git(join(projectDir, "build/vendored"), ["init", "-q"]);

  const found = await ignoredFilesWrittenSince(projectDir, aMomentAgo());

  expect(found.changes.map(({ path }) => path)).toEqual(["build/output.js"]);
});

test("the limit counts the files of every hidden folder together", async () => {
  await writeIgnored("build/a.js", "build/b.js", "dist/c.js", "dist/d.js", "e.log");

  expect((await ignoredFilesWrittenSince(projectDir, aMomentAgo(), 5)).truncated).toBe(false);

  const part = await ignoredFilesWrittenSince(projectDir, aMomentAgo(), 3);
  expect(part.truncated).toBe(true);
  expect(part.changes).toHaveLength(3);
});

test("git is asked to name a hidden folder in whole, so a folder like node_modules is never listed file by file", async () => {
  await writeIgnored("node_modules/pkg/index.js", "build/output.js");
  const gitCalls: string[][] = [];
  const realSpawn = Bun.spawn;
  Bun.spawn = ((command: string[], options: object) => {
    gitCalls.push(command);
    return (realSpawn as (...args: unknown[]) => unknown)(command, options);
  }) as typeof Bun.spawn;

  try {
    await ignoredFilesWrittenSince(projectDir, aMomentAgo());
  } finally {
    Bun.spawn = realSpawn;
  }

  expect(gitCalls.flat()).toContain("--directory");
});

test("a file written in the same clock tick as the turn's start still counts as written during the turn", async () => {
  const folder = await mkdtemp(join(root, "same-tick-"));
  await writeFile(join(folder, "hook.js"), "written the moment the turn began\n");
  const stats = await stat(join(folder, "hook.js"));
  const written = Math.max(stats.mtimeMs, stats.birthtimeMs);

  expect((await filesWrittenSince(folder, written + 10)).changes).toEqual([{ path: "hook.js", status: "added", added: 1, removed: 0 }]);
  expect((await filesWrittenSince(folder, written + 100)).changes).toEqual([]);
  expect(await createdSince(folder, "hook.js", written + 10)).toBe(true);
  expect(await createdSince(folder, "hook.js", written + 100)).toBe(false);
});

test("an untracked file's line count follows the file as it is rewritten, even to the same size", async () => {
  const addedOf = async () => (await uncommittedChanges(projectDir))!.find(({ path }) => path === "new.txt")!.added;
  await write("new.txt", "a\nb\n");
  expect(await addedOf()).toBe(2);
  await write("new.txt", "a\nb\nc\n");
  expect(await addedOf()).toBe(3);
  await write("new.txt", "abcdef");
  const later = new Date(Date.now() + 60_000);
  await utimes(join(projectDir, "new.txt"), later, later);
  expect(await addedOf()).toBe(1);
});

test("many untracked files are all counted, in the order git lists them", async () => {
  await mkdir(join(projectDir, "many"));
  const names = Array.from({ length: 150 }, (_, index) => `many/f${String(index).padStart(3, "0")}.txt`);
  await Promise.all(names.map((name, index) => write(name, "x\n".repeat((index % 7) + 1))));
  const found = (await uncommittedChanges(projectDir))!.filter(({ path }) => path.startsWith("many/"));
  expect(found).toEqual(names.map((path, index) => ({ path, status: "added", added: (index % 7) + 1, removed: 0 })));
});

/** What openFile asks the owner about, or null when it opened the file without asking. */
async function askedAbout(path: string) {
  try {
    await changes.openFile("c1", path);
    return null;
  } catch (error) {
    if (error instanceof OutsideWorkspace) return error.file;
    throw error;
  }
}

test("a file of the workspace, or one outside it that the agent changed, opens with the system's default program without asking", async () => {
  const outside = join(outsideDir, "notes.md");
  await writeFile(outside, "notes\n");
  await write("app.ts", "export {};\n");
  await startTurn();
  expect(await askedAbout("app.ts")).toBeNull();
  agentEdits("t1", outside, null, "notes\n");
  expect(await askedAbout(outside)).toBeNull();
  expect(openedByDefault).toEqual([realpathSync.native(join(projectDir, "app.ts")), realpathSync.native(outside)]);
});

test("a file outside the workspace that the agent did not change asks first, naming its real path, and opens once the owner agrees", async () => {
  const outside = join(outsideDir, "notes.md");
  await writeFile(outside, "notes\n");
  await startTurn();
  expect(await askedAbout(outside)).toBe(realpathSync.native(outside));
  expect(await askedAbout(join("..", "elsewhere", "notes.md"))).toBe(realpathSync.native(outside));
  expect(openedByDefault).toEqual([]);
  await changes.openFile("c1", realpathSync.native(outside), true);
  expect(openedByDefault).toEqual([realpathSync.native(outside)]);
});

test("a program outside the workspace stays refused once the owner agrees, and a script there opens as text", async () => {
  await writeFile(join(outsideDir, "tool.jar"), "");
  await writeFile(join(outsideDir, "run.sh"), "#!/bin/sh\n");
  await startTurn();
  await expect(changes.openFile("c1", join(outsideDir, "tool.jar"), true)).rejects.toThrow("would run as a program");
  await changes.openFile("c1", join(outsideDir, "run.sh"), true);
  expect(openedAsText).toEqual([realpathSync.native(join(outsideDir, "run.sh"))]);
  expect(openedByDefault).toEqual([]);
});

test("a file no program is set to open opens as text when it is text, and otherwise says no program opens it", async () => {
  defaultProgramOpens = false;
  await write("beads.jsonl", '{"id":1}\n');
  await writeFile(join(projectDir, "photo.raw"), new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08]));
  await startTurn();
  await changes.openFile("c1", "beads.jsonl");
  await expect(changes.openFile("c1", "photo.raw")).rejects.toThrow("No program is set to open photo.raw, and it is not text, so Mirador cannot open it.");
  expect(openedByDefault).toEqual(["beads.jsonl", "photo.raw"].map((name) => realpathSync.native(join(projectDir, name))));
  expect(openedAsText).toEqual([realpathSync.native(join(projectDir, "beads.jsonl"))]);
});

test("a file the text editor does not open says so, whether a script or a file no program is set for", async () => {
  defaultProgramOpens = false;
  textEditorOpens = false;
  await write("run.sh", "echo hi\n");
  await write("beads.jsonl", '{"id":1}\n');
  await startTurn();
  await expect(changes.openFile("c1", "run.sh")).rejects.toThrow("Mirador could not open run.sh as text.");
  await expect(changes.openFile("c1", "beads.jsonl")).rejects.toThrow("Mirador could not open beads.jsonl as text.");
});

test("a file named by the workspace's real path opens, though the workspace was added through a link to it", async () => {
  const link = join(root, "link");
  await symlink(projectDir, link);
  const linked = new Changes(store, checkpoints, () => ({ ...workspace(), path: link }), () => {}, openerNoting(openedByDefault, () => true), openerNoting([], () => true));
  await startTurn();
  await linked.openFile("c1", join(projectDir, "kept.txt"));
  await linked.openFile("c1", "kept.txt");
  await linked.openFile("c1", join(link, "kept.txt"));
  expect(openedByDefault).toEqual(Array(3).fill(realpathSync.native(join(projectDir, "kept.txt"))));
});

test("the session scope lists every file the agent changed since the conversation began, even when a later turn changed it back", async () => {
  await write("app.ts", "one\n");
  await git(projectDir, ["add", "-A"]);
  await git(projectDir, ["commit", "-qm", "base"]);
  await startTurn();
  agentEdits("t1", join(projectDir, "app.ts"), "one\n", "two\n");
  await write("app.ts", "one\n");
  await startTurn();
  const session = await changes.list("c1", "session");
  expect(session.base).toBe("session");
  expect(session.project.map((file) => file.path)).toEqual(["app.ts"]);
  expect((await changes.list("c1", "turn")).project).toEqual([]);
});

test("a file that is gone is refused rather than handed to the system's default program", async () => {
  await startTurn();
  await symlink(join(projectDir, "missing.ts"), join(projectDir, "dangling.md"));
  await expect(changes.openFile("c1", "missing.ts")).rejects.toThrow(`missing.ts does not exist in ${projectDir}.`);
  await expect(changes.openFile("c1", "dangling.md")).rejects.toThrow(`dangling.md does not exist in ${projectDir}.`);
  await expect(changes.openFile("c1", join(outsideDir, "gone.md"))).rejects.toThrow(`${join(outsideDir, "gone.md")} does not exist.`);
  expect(openedByDefault).toEqual([]);
});

test("a link named like a document that leads to a program is refused, as the system would run what it leads to", async () => {
  await startTurn();
  await mkdir(join(projectDir, "tools"));
  await mkdir(join(projectDir, "docs"));
  await write("tools/run.jar", "");
  await symlink(join(projectDir, "tools", "run.jar"), join(projectDir, "docs", "guide.md"));
  await expect(changes.openFile("c1", "docs/guide.md")).rejects.toThrow("docs/guide.md would run as a program");
  expect(openedByDefault).toEqual([]);
});

test.if(process.platform === "darwin")("on macOS a link named like a document that leads to an app or a Terminal file is refused", async () => {
  await startTurn();
  await mkdir(join(projectDir, "tools", "Evil.app", "Contents"), { recursive: true });
  await write("tools/shell.terminal", "");
  await symlink(join(projectDir, "tools", "Evil.app"), join(projectDir, "notes.md"));
  await symlink(join(projectDir, "tools", "shell.terminal"), join(projectDir, "readme.txt"));
  await expect(changes.openFile("c1", "notes.md")).rejects.toThrow("would run as a program");
  await expect(changes.openFile("c1", "readme.txt")).rejects.toThrow("would run as a program");
  expect(openedByDefault).toEqual([]);
});

test("a link in the workspace that leads outside it asks first, naming the file it leads to, until the agent changed that file", async () => {
  const outside = join(outsideDir, "secret.txt");
  await writeFile(outside, "secret\n");
  await symlink(outside, join(projectDir, "notes.md"));
  await startTurn();
  expect(await askedAbout("notes.md")).toBe(realpathSync.native(outside));
  expect(openedByDefault).toEqual([]);
  agentEdits("t1", outside, null, "secret\n");
  expect(await askedAbout("notes.md")).toBeNull();
  expect(openedByDefault).toEqual([realpathSync.native(outside)]);
});

test("a link added in the turn to a file outside the workspace shows its target path in the diff, not that file's contents", async () => {
  const outside = join(outsideDir, "secret.txt");
  await writeFile(outside, "secret\n");
  await startTurn();
  await symlink(outside, join(projectDir, "notes.md"));

  expect((await changes.list("c1", "turn")).project).toEqual([{ path: "notes.md", status: "added", added: 1, removed: 0, byAgent: false }]);
  const diff = await changes.diff("c1", "turn", "notes.md");
  expect(diff.source).toBe("files");
  expect(diff.diffs[0]!.hunks.flatMap((hunk) => hunk.rows).filter(({ kind }) => kind !== "context")).toEqual([{ kind: "added", oldLine: null, newLine: 1, text: outside }]);
});

test("a file reached through a linked folder that leads outside the workspace is refused", async () => {
  await writeFile(join(outsideDir, "secret.txt"), "secret\n");
  await startTurn();
  await symlink(outsideDir, join(projectDir, "linked"));

  await expect(changes.diff("c1", "turn", "linked/secret.txt")).rejects.toThrow("linked/secret.txt leads outside this workspace, so Mirador does not show it.");
});

test("a new untracked link counts no lines of the file it leads to", async () => {
  await writeFile(join(outsideDir, "many.txt"), "one\ntwo\nthree\n");
  await symlink(join(outsideDir, "many.txt"), join(projectDir, "link.txt"));

  expect((await changes.list("c1", "uncommitted")).project).toEqual([{ path: "link.txt", status: "added", added: null, removed: null, byAgent: false }]);
});

test("a program is refused rather than handed to the system's default program, which would run it", async () => {
  await startTurn();
  const program = process.platform === "win32" ? "build.bat" : "build";
  await write(program, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
  await chmod(join(projectDir, program), 0o755);
  await write("tool.jar", "");
  await expect(changes.openFile("c1", program)).rejects.toThrow("would run as a program");
  await expect(changes.openFile("c1", "tool.jar")).rejects.toThrow("would run as a program");
  expect([...openedByDefault, ...openedAsText]).toEqual([]);
});

test("a script opens as text, executable or not, and through a link named like a document too, never with the system's default program", async () => {
  await startTurn();
  await write("run.sh", "#!/bin/sh\n");
  await chmod(join(projectDir, "run.sh"), 0o755);
  await write("tool.py", "print()\n");
  await symlink(join(projectDir, "tool.py"), join(projectDir, "notes.md"));
  await changes.openFile("c1", "run.sh");
  await changes.openFile("c1", "tool.py");
  await changes.openFile("c1", "notes.md");
  expect(openedAsText).toEqual(["run.sh", "tool.py", "tool.py"].map((file) => realpathSync.native(join(projectDir, file))));
  expect(openedByDefault).toEqual([]);
});

test("the session scope adds the git-ignored files written since the session began, and leaves out tracked files that only git lists", async () => {
  await write(".gitignore", "build/\n");
  await write("app.ts", "one\n");
  await git(projectDir, ["add", "-A"]);
  await git(projectDir, ["commit", "-qm", "base"]);
  await startTurn();
  await Bun.sleep(20);
  await mkdir(join(projectDir, "build"));
  await writeFile(join(projectDir, "build", "out.js"), "built\n");
  await write("app.ts", "two\n");
  const session = await changes.list("c1", "session");
  expect(session.project.map((file) => file.path)).toEqual(["build/out.js"]);
});

test("the session scope leaves out the git-ignored files written before the conversation's first message", async () => {
  await mkdir(join(projectDir, "build"));
  await writeFile(join(projectDir, "build", "old.js"), "built before\n");
  await Bun.sleep(50);
  await startTurn();
  await Bun.sleep(20);
  await writeFile(join(projectDir, "build", "new.js"), "built in the session\n");
  const session = await changes.list("c1", "session");
  expect(session.project.map((file) => file.path)).toEqual(["build/new.js"]);
});

async function writeToolState() {
  await mkdir(join(projectDir, ".beads", "backup"), { recursive: true });
  await mkdir(join(projectDir, ".dolt", "noms"), { recursive: true });
  await mkdir(join(projectDir, ".idea"), { recursive: true });
  await write(".beads/backup/chunk.darc", "beads\n");
  await write(".dolt/noms/manifest", "dolt\n");
  await write(".idea/workspace.xml", "ide\n");
}

test("the session leaves out the git-ignored folders tools keep their own state in", async () => {
  await write(".gitignore", "build\n.beads\n.dolt\n.idea\n");
  await git(projectDir, ["commit", "-qam", "ignore tool state"]);
  await startTurn();
  await Bun.sleep(20);
  await writeToolState();
  await write("build", "built\n");
  expect((await changes.list("c1", "session")).project.map((file) => file.path)).toEqual(["build"]);
});

test("outside a git repository, a turn leaves out the folders tools keep their own state in", async () => {
  await leaveGit();
  await startTurn();
  await Bun.sleep(20);
  await writeToolState();
  await write("out.txt", "written\n");
  expect((await changes.list("c1", "turn")).project.map((file) => file.path)).toEqual(["out.txt"]);
});

test("the session lists the git-ignored files in ignored folders and by name, and none of an untracked folder's or node_modules'", async () => {
  await write(".gitignore", "build/\n*.log\nnode_modules/\n");
  await git(projectDir, ["commit", "-qam", "ignore more"]);
  await startTurn();
  await Bun.sleep(20);
  await Promise.all(["build/deep", "src", "untracked", "node_modules/pkg"].map((folder) => mkdir(join(projectDir, folder), { recursive: true })));
  await write("build/deep/out.js", "built\n");
  await write("src/debug.log", "logged\n");
  await write("untracked/new.txt", "new\n");
  await write("node_modules/pkg/index.js", "installed\n");
  expect((await changes.list("c1", "session")).project.map((file) => file.path)).toEqual(["build/deep/out.js", "src/debug.log"]);
});

test("a file written in a submodule or a nested clone leaves the session's other git-ignored files listed", async () => {
  const library = join(projectDir, "..", "library");
  await mkdir(library);
  await git(library, ["init", "-q"]);
  await git(library, ["commit", "-q", "--allow-empty", "-m", "library"]);
  await write(".gitignore", "*.log\n");
  await git(projectDir, ["add", ".gitignore"]);
  await Promise.all(["a", "nested", "z"].map((folder) => mkdir(join(projectDir, folder))));
  await git(projectDir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "m-submodule"]);
  await git(projectDir, ["commit", "-qm", "add the submodule"]);
  await git(join(projectDir, "nested"), ["init", "-q"]);
  await git(join(projectDir, "nested"), ["commit", "-q", "--allow-empty", "-m", "nested"]);
  await startTurn();
  await Bun.sleep(20);
  const written = ["a.log", "a/first.log", "m-submodule/inside.log", "nested/inside.log", "z/last.log", "z.log"];
  await Promise.all(written.map((path) => write(path, "logged\n")));
  expect((await changes.list("c1", "session")).project.map((file) => file.path).sort()).toEqual(["a.log", "a/first.log", "z.log", "z/last.log"]);
});

test("before the first message the session scope lists only the agent's edits, such as a continued session's replayed ones, and no file a script wrote", async () => {
  store.appendEvent("c1", { type: "acp", update: { sessionUpdate: "current_mode_update", currentModeId: "default" } });
  await mkdir(join(projectDir, "build"));
  await writeFile(join(projectDir, "build", "hook.js"), "written as the session started\n");
  expect(await changes.list("c1", "session")).toEqual({ scope: "session", base: "session", project: [], committed: [], outside: [] });

  agentEdits("replayed", join(projectDir, "kept.txt"), "two", "TWO");
  expect((await changes.list("c1", "session")).project).toEqual([{ path: "kept.txt", status: "modified", added: null, removed: null, byAgent: true }]);
});

test("a git-ignored file a script rewrote in the session says git ignores it, rather than that the folder is no repository", async () => {
  await mkdir(join(projectDir, "build"));
  await writeFile(join(projectDir, "build", "cache.js"), "from before\n");
  await Bun.sleep(50);
  await startTurn();
  await writeFile(join(projectDir, "build", "cache.js"), "rewritten by a script\n");
  expect((await changes.list("c1", "session")).project).toEqual([{ path: "build/cache.js", status: "modified", added: null, removed: null, byAgent: false }]);
  expect((await changes.diff("c1", "session", "build/cache.js")).diffs[0]).toMatchObject({ hiddenBecause: "git ignores this file, so there is no earlier version to compare with" });
});

test("outside a git repository, the session lists every file written since it began, and says the folder is no repository", async () => {
  await leaveGit();
  await startTurn();
  await Bun.sleep(20);
  await write("doomed.txt", "rewritten by a script\n");
  const session = await changes.list("c1", "session");
  expect(session.base).toBe("session");
  expect(session.project.map((file) => file.path)).toEqual(["doomed.txt"]);
  expect((await changes.diff("c1", "session", "doomed.txt")).diffs[0]).toMatchObject({ hiddenBecause: expect.stringContaining("not a git repository") });
});
