import { copyFile, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { RestorePlan, Workspace } from "../shared/model.ts";
import { treeChangesIn, type TreeChange } from "./working-tree.ts";

/** Where snapshots hung, one after another, before each got a ref of its own. */
const chainRefOf = (workspaceId: string) => `refs/mirador/${workspaceId}`;
const snapshotRefsOf = (workspaceId: string) => `refs/mirador/turns/${workspaceId}/`;
/** Named by when it was taken, so the names sort oldest first; the chain from before sorts ahead of every snapshot. */
const snapshotRefOf = (workspaceId: string, commit: string, takenAt: number) => `${snapshotRefsOf(workspaceId)}${String(takenAt).padStart(16, "0")}-${commit}`;

export const SNAPSHOTS_KEPT = 100;

const SUBMODULE_MODE = "160000";

/**
 * git's `-z --raw` output: each change's modes, objects and status (":100644 100644 <old> <new> M"), then its path, each
 * ended by NUL, with names left as they are.
 */
function changesIn(output: string) {
  const fields = output.split("\0").filter(Boolean);
  return fields.flatMap((field, index) => {
    if (index % 2 === 1) return [];
    const [fromMode, toMode, , , status = ""] = field.slice(1).split(" ");
    return [{ status, path: fields[index + 1] ?? "", submodule: fromMode === SUBMODULE_MODE || toMode === SUBMODULE_MODE }];
  });
}

/** A path git reported names a file of this workspace; any other path is not ours to delete. */
function withinWorkspace(workspace: Workspace, path: string) {
  const root = resolve(workspace.path);
  return resolve(root, path).startsWith(root + sep);
}
const SNAPSHOT_MESSAGE = "mirador: the files at the start of a turn";
/** Names the HEAD the staging was taken on: staging put back onto another HEAD would stage a revert of what was committed since. */
const stagingMessageOn = (head: string) => `mirador: the staged files at the start of a turn\n\nHEAD ${head || "unborn"}`;
/** Mirador's own commits need no identity or signing setup from the user's git config. */
export const IDENTITY = ["-c", "user.name=mirador", "-c", "user.email=mirador@localhost", "-c", "commit.gpgsign=false"];

/**
 * The files of a workspace, kept per turn so a turn can be undone.
 *
 * The workspace's own repository does the storing, through an index of our own (`GIT_INDEX_FILE`), so nothing of the
 * user's branch, HEAD or reflog is touched: a snapshot writes the file contents it does not already have as objects,
 * plus one commit with a ref of its own under `refs/mirador/turns/<workspace>/`, whose parent holds what the user had
 * staged. Only the newest `keep` refs stay; git's own gc drops what the others alone held. Restoring writes the working
 * tree and puts back the staging of the files it writes, so a file the agent staged is not left queued for the user's
 * next commit. A submodule's own files are its repository's, so a restore leaves a submodule as it is and says so.
 *
 * A workspace that is not a git repository has no snapshots, and so no undo.
 */
type GitOptions = { input?: string; index?: string };

export class Checkpoints {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataDir: string,
    private readonly keep = SNAPSHOTS_KEPT,
  ) {}

  /** The workspace's files as they are now, or null when it is not a git repository. */
  snapshot(workspace: Workspace): Promise<string | null> {
    return this.inOrder(workspace.id, async () => {
      if (!(await this.isRepository(workspace))) return null;
      const tree = await this.stageEverything(workspace);
      const staging = await this.commitOfStaging(workspace);
      const commit = (await this.mustGit(workspace, ["commit-tree", tree, ...(staging ? ["-p", staging] : []), "-m", SNAPSHOT_MESSAGE])).stdout;
      await this.mustGit(workspace, ["update-ref", snapshotRefOf(workspace.id, commit, Date.now()), commit]);
      await this.moveChainToItsOwnRef(workspace);
      await this.dropAllButNewest(workspace);
      return commit;
    });
  }

  /** Whether the snapshot's files are still in the repository: once its ref is dropped, git's gc may take them. */
  keeps(workspace: Workspace, commit: string): Promise<boolean> {
    return this.inOrder(workspace.id, async () => (await this.git(workspace, ["cat-file", "-e", `${commit}^{tree}`])).exitCode === 0);
  }

  /**
   * The workspace's files that differ from the snapshot `commit`, staged into our index as the snapshot was, so a file
   * .gitignore hides counts on neither side; null when the workspace is not a git repository.
   */
  changesSince(workspace: Workspace, commit: string): Promise<TreeChange[] | null> {
    return this.inOrder(workspace.id, async () => {
      if (!(await this.isRepository(workspace))) return null;
      const now = await this.stageEverything(workspace);
      const diff = async (format: string) => (await this.mustGit(workspace, ["diff-tree", "-r", "-z", "--relative", "--no-renames", format, commit, now])).stdout;
      return treeChangesIn(await diff("--raw"), await diff("--numstat"));
    });
  }

  /** What restoring `commit` would do, without touching a file; null when the workspace is not a git repository. */
  preview(workspace: Workspace, commit: string): Promise<RestorePlan | null> {
    return this.inOrder(workspace.id, async () => {
      if (!(await this.isRepository(workspace))) return null;
      const { restored, removed, submodulesLeft } = await this.diffToNow(workspace, commit);
      return { restored, removed, ...(submodulesLeft > 0 && { submodulesLeft }) };
    });
  }

  /** Puts the workspace's files back as they were when `commit` was taken, deleting what came after it. */
  restore(workspace: Workspace, commit: string): Promise<RestorePlan> {
    return this.inOrder(workspace.id, async () => {
      const { restored, removed, added, written, submodulesLeft } = await this.diffToNow(workspace, commit);
      await this.deleteFiles(workspace, added);
      await this.mustGit(workspace, ["read-tree", commit]);
      await this.mustGit(workspace, ["checkout-index", "-a", "-f"]);
      await this.restoreStaging(workspace, commit, written);
      return { restored, removed, ...(submodulesLeft > 0 && { submodulesLeft }) };
    });
  }

  /** The chain the snapshots made before each got a ref: its newest snapshot holds the rest, and ages out like any. */
  private async moveChainToItsOwnRef(workspace: Workspace) {
    const chain = await this.git(workspace, ["rev-parse", "--verify", "--quiet", chainRefOf(workspace.id)]);
    if (chain.exitCode !== 0) return;
    await this.mustGit(workspace, ["update-ref", snapshotRefOf(workspace.id, chain.stdout, 0), chain.stdout]);
    await this.mustGit(workspace, ["update-ref", "-d", chainRefOf(workspace.id)]);
  }

  private async dropAllButNewest(workspace: Workspace) {
    const refs = await this.mustGit(workspace, ["for-each-ref", "--sort=-refname", "--format=%(refname)", snapshotRefsOf(workspace.id)]);
    const dropped = refs.stdout.split("\n").filter(Boolean).slice(this.keep);
    if (dropped.length > 0) await this.mustGit(workspace, ["update-ref", "--stdin"], { input: dropped.map((ref) => `delete ${ref}\n`).join("") });
  }

  /** A snapshot of one workspace at a time: git's own index lock is per file, and the file is ours. */
  private inOrder<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(workspaceId) ?? Promise.resolve()).then(work, work);
    this.queues.set(
      workspaceId,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * What a restore would change: what to put back or rewrite, what to delete, the paths to delete, every path it writes or
   * deletes, and the submodules it leaves.
   */
  private async diffToNow(workspace: Workspace, commit: string) {
    const now = await this.stageEverything(workspace);
    const diff = await this.git(workspace, ["diff-tree", "-r", "-z", "--raw", "--relative", "--no-renames", commit, now]);
    const changes = changesIn(diff.stdout);
    const files = changes.filter(({ submodule }) => !submodule);
    const withStatus = (letters: string[]) => files.filter(({ status }) => letters.includes(status)).length;
    const added = files.filter(({ status }) => status === "A").map(({ path }) => path);
    const written = files.map(({ path }) => path);
    return { restored: withStatus(["M", "D"]), removed: added.length, added, written, submodulesLeft: changes.length - files.length };
  }

  /**
   * What the user has staged, as a commit of its own, written from a copy of their index so theirs is never locked; null
   * when git cannot write it, as during a merge conflict.
   */
  private async commitOfStaging(workspace: Workspace) {
    const copy = join(this.dataDir, "checkpoints", `${workspace.id}.staging.index`);
    try {
      if (!(await copyFile(await this.usersIndexOf(workspace), copy).then(() => true, () => false))) return null;
      const tree = await this.git(workspace, ["write-tree"], { index: copy });
      if (tree.exitCode !== 0) return null;
      return (await this.mustGit(workspace, ["commit-tree", tree.stdout, "-m", stagingMessageOn(await this.headOf(workspace))])).stdout;
    } finally {
      await rm(copy, { force: true });
    }
  }

  /**
   * Puts the user's staging of the files a restore wrote back as the snapshot kept it. A snapshot that kept none, being
   * older or taken during a merge conflict, or one taken on a HEAD that has since moved, unstages those whose staged
   * version is not the restored file instead.
   */
  private async restoreStaging(workspace: Workspace, commit: string, written: string[]) {
    const index = await this.usersIndexOf(workspace);
    const keptStaging = await this.keepsStagingOnHead(workspace, commit);
    const unstaged = keptStaging ? written : await this.stagedOtherwise(workspace, index, written);
    if (unstaged.length === 0) return;
    const resetTo = keptStaging ? [`${commit}^`] : [];
    await this.mustGit(workspace, ["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul", ...resetTo], { input: unstaged.map((path) => `${path}\0`).join(""), index });
  }

  /** An older snapshot's parent, if it has one, is the snapshot before it rather than any staging. */
  private async keepsStagingOnHead(workspace: Workspace, commit: string) {
    const parent = await this.git(workspace, ["show", "-s", "--format=%B", `${commit}^`]);
    return parent.exitCode === 0 && parent.stdout === stagingMessageOn(await this.headOf(workspace));
  }

  private async headOf(workspace: Workspace) {
    return (await this.git(workspace, ["rev-parse", "--verify", "--quiet", "HEAD"])).stdout;
  }

  private async stagedOtherwise(workspace: Workspace, index: string, paths: string[]) {
    const differing = new Set((await this.mustGit(workspace, ["diff", "--name-only", "-z", "--relative"], { index })).stdout.split("\0"));
    return paths.filter((path) => differing.has(path));
  }

  private async usersIndexOf(workspace: Workspace) {
    return resolve(workspace.path, (await this.mustGit(workspace, ["rev-parse", "--git-dir"])).stdout, "index");
  }

  private async isRepository(workspace: Workspace) {
    return (await this.git(workspace, ["rev-parse", "--git-dir"])).exitCode === 0;
  }

  /** Writes the working tree into our index, which git compares against the files it hashed last time. */
  private async stageEverything(workspace: Workspace) {
    await this.mustGit(workspace, ["add", "-A"]);
    return (await this.mustGit(workspace, ["write-tree"])).stdout;
  }

  private async deleteFiles(workspace: Workspace, paths: string[]) {
    await Promise.all(
      paths.filter((path) => withinWorkspace(workspace, path)).map(async (path) => {
        const full = join(workspace.path, path);
        await rm(full, { force: true });
        await this.pruneEmptyDirectories(workspace.path, dirname(full));
      }),
    );
  }

  /** A folder that held only deleted files would otherwise be left behind, empty. */
  private async pruneEmptyDirectories(root: string, from: string) {
    for (let directory = from; directory !== root && directory.startsWith(root); directory = dirname(directory)) {
      if ((await readdir(directory).catch(() => [""])).length > 0) return;
      await rmdir(directory).catch(() => {});
    }
  }

  /** git for the calls whose failure the user has to hear about, rather than one that only answers a question. */
  private async mustGit(workspace: Workspace, args: string[], options: GitOptions = {}) {
    const result = await this.git(workspace, args, options);
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${workspace.path}: ${result.stderr || result.stdout}`);
    return result;
  }

  /** On our own index unless told another; paths given to git are taken as they are, never as patterns. */
  private async git(workspace: Workspace, args: string[], { input, index = join(this.dataDir, "checkpoints", `${workspace.id}.index`) }: GitOptions = {}) {
    await mkdir(join(this.dataDir, "checkpoints"), { recursive: true });
    const child = Bun.spawn(["git", "-C", workspace.path, ...IDENTITY, ...args], {
      env: { ...process.env, GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" },
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  }
}
