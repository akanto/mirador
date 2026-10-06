import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { RestorePlan, Workspace } from "../shared/model.ts";

const refOf = (workspaceId: string) => `refs/mirador/${workspaceId}`;

/** git's `-z --name-status` output: a status and a path, each ended by NUL, with names left as they are. */
function statusAndPathOf(output: string) {
  const fields = output.split("\0").filter(Boolean);
  return fields.flatMap((field, index) => (index % 2 === 1 ? [] : [{ status: field, path: fields[index + 1] ?? "" }]));
}

/** A path git reported names a file of this workspace; any other path is not ours to delete. */
function withinWorkspace(workspace: Workspace, path: string) {
  const root = resolve(workspace.path);
  return resolve(root, path).startsWith(root + sep);
}
const SNAPSHOT_MESSAGE = "mirador: the files at the start of a turn";
const IDENTITY = ["-c", "user.name=mirador", "-c", "user.email=mirador@localhost", "-c", "commit.gpgsign=false"];

/**
 * The files of a workspace, kept per turn so a turn can be undone.
 *
 * The workspace's own repository does the storing, through an index of our own (`GIT_INDEX_FILE`), so nothing of the
 * user's staging area, branch, HEAD or reflog is touched: a snapshot writes the file contents it does not already
 * have as objects, plus one commit per snapshot under `refs/mirador/<workspace>`, whose parent is the snapshot before
 * it. Restoring writes the working tree only, which is why its effect is ordinary uncommitted changes to the user.
 *
 * A workspace that is not a git repository has no snapshots, and so no undo.
 */
export class Checkpoints {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly dataDir: string) {}

  /** The workspace's files as they are now, or null when it is not a git repository. */
  snapshot(workspace: Workspace): Promise<string | null> {
    return this.inOrder(workspace.id, async () => {
      if (!(await this.isRepository(workspace))) return null;
      const tree = await this.stageEverything(workspace);
      const previous = await this.currentSnapshot(workspace);
      const commit = await this.mustGit(workspace, ["commit-tree", tree, ...(previous ? ["-p", previous] : []), "-m", SNAPSHOT_MESSAGE]);
      await this.mustGit(workspace, ["update-ref", refOf(workspace.id), commit.stdout]);
      return commit.stdout;
    });
  }

  /** What restoring `commit` would do, without touching a file; null when the workspace is not a git repository. */
  preview(workspace: Workspace, commit: string): Promise<RestorePlan | null> {
    return this.inOrder(workspace.id, async () => {
      if (!(await this.isRepository(workspace))) return null;
      const { restored, removed } = await this.diffToNow(workspace, commit);
      return { restored, removed };
    });
  }

  /** Puts the workspace's files back as they were when `commit` was taken, deleting what came after it. */
  restore(workspace: Workspace, commit: string): Promise<RestorePlan> {
    return this.inOrder(workspace.id, async () => {
      const { restored, removed, added } = await this.diffToNow(workspace, commit);
      await this.deleteFiles(workspace, added);
      await this.mustGit(workspace, ["read-tree", commit]);
      await this.mustGit(workspace, ["checkout-index", "-a", "-f"]);
      return { restored, removed };
    });
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

  /** What a restore would change: what to put back or rewrite, what to delete, and the paths to delete. */
  private async diffToNow(workspace: Workspace, commit: string) {
    const now = await this.stageEverything(workspace);
    const diff = await this.git(workspace, ["diff-tree", "-r", "-z", "--name-status", "--no-renames", commit, now]);
    const changes = statusAndPathOf(diff.stdout);
    const withStatus = (letters: string[]) => changes.filter(({ status }) => letters.includes(status)).length;
    const added = changes.filter(({ status }) => status === "A").map(({ path }) => path);
    return { restored: withStatus(["M", "D"]), removed: added.length, added };
  }

  private async isRepository(workspace: Workspace) {
    return (await this.git(workspace, ["rev-parse", "--git-dir"])).exitCode === 0;
  }

  private async currentSnapshot(workspace: Workspace) {
    const ref = await this.git(workspace, ["rev-parse", "--verify", "--quiet", refOf(workspace.id)]);
    return ref.exitCode === 0 ? ref.stdout : null;
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
  private async mustGit(workspace: Workspace, args: string[]) {
    const result = await this.git(workspace, args);
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${workspace.path}: ${result.stderr || result.stdout}`);
    return result;
  }

  private async git(workspace: Workspace, args: string[]) {
    const index = join(this.dataDir, "checkpoints", `${workspace.id}.index`);
    await mkdir(dirname(index), { recursive: true });
    const child = Bun.spawn(["git", "-C", workspace.path, ...IDENTITY, ...args], {
      env: { ...process.env, GIT_INDEX_FILE: index },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  }
}
