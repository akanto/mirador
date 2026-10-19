import { copyFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { RestorePlan, Workspace } from "../shared/model.ts";
import { CheckpointGit, changesIn, NO_FILE_MODE, type Location } from "./checkpoints/git.ts";
import { OwnBytesStaging, type Staged } from "./checkpoints/own-bytes.ts";
import { PutBack, type PutBackPlan } from "./checkpoints/put-back.ts";
import { treeChangesIn, type TreeChange } from "./working-tree.ts";

/** Where snapshots hung, one after another, before each got a ref of its own. */
const chainRefOf = (workspaceId: string) => `refs/mirador/${workspaceId}`;
const snapshotRefsOf = (workspaceId: string) => `refs/mirador/turns/${workspaceId}/`;
/** Named by when it was taken, so the names sort oldest first; the chain from before sorts ahead of every snapshot. */
const snapshotRefOf = (workspaceId: string, commit: string, takenAt: number) => `${snapshotRefsOf(workspaceId)}${String(takenAt).padStart(16, "0")}-${commit}`;

export const SNAPSHOTS_KEPT = 100;

const SNAPSHOT_MESSAGE = "mirador: the files at the start of a turn";
/** Marks a snapshot that holds each file's own bytes: one without it holds them as git's attributes converted them. */
const OWN_BYTES_NOTE = "Each file is kept as its own bytes, but those a filter cleans, which are kept as git stores them.";
const CLEANED_PREFIX = "Cleaned by a filter: ";
const snapshotMessageOf = (cleaned: string[]) => [SNAPSHOT_MESSAGE, "", OWN_BYTES_NOTE, ...(cleaned.length > 0 ? [`${CLEANED_PREFIX}${JSON.stringify(cleaned)}`] : [])].join("\n");
/** Names the HEAD the staging was taken on: staging put back onto another HEAD would stage a revert of what was committed since. */
const stagingMessageOn = (head: string) => `mirador: the staged files at the start of a turn\n\nHEAD ${head || "unborn"}`;

type RestoreDiff = PutBackPlan & { restored: number; removed: number; written: string[]; submodulesLeft: number };

/**
 * The files of a workspace, kept per turn so a turn can be undone.
 *
 * The workspace's own repository does the storing, through indexes of our own (`GIT_INDEX_FILE`), so nothing of the
 * user's branch, HEAD or reflog is touched: a snapshot writes the file contents it does not already have as objects,
 * plus one commit with a ref of its own under `refs/mirador/turns/<workspace>/`, whose parent holds what the user had
 * staged. Only the newest `keep` refs stay; git's own gc drops what the others alone held. Restoring writes the working
 * tree and puts back the staging of the files it writes, so a file the agent staged is not left queued for the user's
 * next commit. A submodule's own files are its repository's, so a restore leaves a submodule as it is and says so.
 *
 * A snapshot holds each file's own bytes, which OwnBytesStaging keeps beside our staging index, and a file a filter
 * cleans in the filter's form. Snapshots taken before hold the files as git's attributes converted them, and a restore
 * of one writes the files it puts back the way git checks them out.
 *
 * A workspace that is not a git repository has no snapshots, and so no undo.
 */
export class Checkpoints {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly git: CheckpointGit;
  private readonly ownBytesStaging: OwnBytesStaging;
  private readonly putBack: PutBack;

  constructor(
    dataDir: string,
    private readonly keep = SNAPSHOTS_KEPT,
  ) {
    this.git = new CheckpointGit(dataDir);
    this.ownBytesStaging = new OwnBytesStaging(this.git);
    this.putBack = new PutBack(this.git);
  }

  /** The workspace's files as they are now, or null when it is not a git repository. */
  snapshot(workspace: Workspace): Promise<string | null> {
    return this.inOrder(workspace.id, async () => {
      const location = await this.locate(workspace);
      if (!location) return null;
      const { ownBytes, cleaned } = await this.ownBytesStaging.stageEverything(workspace, location);
      const staging = await this.commitOfStaging(workspace);
      const commit = (await this.git.mustRun(workspace, ["commit-tree", ownBytes, ...(staging ? ["-p", staging] : []), "-F", "-"], { input: snapshotMessageOf(cleaned) })).stdout;
      await this.git.mustRun(workspace, ["update-ref", snapshotRefOf(workspace.id, commit, Date.now()), commit]);
      await this.moveChainToItsOwnRef(workspace);
      await this.dropAllButNewest(workspace);
      return commit;
    });
  }

  /** Whether the snapshot's files are still in the repository: once its ref is dropped, git's gc may take them. */
  keeps(workspace: Workspace, commit: string): Promise<boolean> {
    return this.inOrder(workspace.id, async () => (await this.git.run(workspace, ["cat-file", "-e", `${commit}^{tree}`])).exitCode === 0);
  }

  /**
   * The workspace's files that differ from the snapshot `commit`, staged into our index as the snapshot was, so a file
   * .gitignore hides counts on neither side; null when the workspace is not a git repository.
   */
  changesSince(workspace: Workspace, commit: string): Promise<TreeChange[] | null> {
    return this.inOrder(workspace.id, async () => {
      const location = await this.locate(workspace);
      if (!location) return null;
      const keptAs = await this.keptAs(workspace, commit);
      const now = this.treeLike(keptAs, await this.ownBytesStaging.stageEverything(workspace, location));
      const diff = async (format: string) => (await this.git.mustRun(workspace, ["diff-tree", "-r", "-z", "--relative", "--no-renames", format, commit, now])).stdout;
      return treeChangesIn(await diff("--raw"), await diff("--numstat"));
    });
  }

  /** What restoring `commit` would do, without touching a file; null when the workspace is not a git repository. */
  preview(workspace: Workspace, commit: string): Promise<RestorePlan | null> {
    return this.inOrder(workspace.id, async () => {
      const location = await this.locate(workspace);
      if (!location) return null;
      const { restored, removed, submodulesLeft } = await this.diffToNow(workspace, location, commit, await this.keptAs(workspace, commit));
      return { restored, removed, ...(submodulesLeft > 0 && { submodulesLeft }) };
    });
  }

  /** Puts the workspace's files back as they were when `commit` was taken, deleting what came after it. */
  restore(workspace: Workspace, commit: string): Promise<RestorePlan> {
    return this.inOrder(workspace.id, async () => {
      const location = await this.locate(workspace);
      if (!location) throw new Error(`${workspace.path} is not in a git repository`);
      const keptAs = await this.keptAs(workspace, commit);
      const plan = await this.diffToNow(workspace, location, commit, keptAs);
      if (keptAs.ownBytes) await this.putBack.ownBytes(workspace, location, plan, keptAs.cleaned);
      else await this.putBack.asGitChecksOut(workspace, commit, plan);
      await this.restoreStaging(workspace, commit, plan.written);
      return { restored: plan.restored, removed: plan.removed, ...(plan.submodulesLeft > 0 && { submodulesLeft: plan.submodulesLeft }) };
    });
  }

  /** Whether the snapshot holds the files' own bytes, and which of them, by their path from the repository's top, a filter cleaned. */
  private async keptAs(workspace: Workspace, commit: string) {
    const lines = (await this.git.run(workspace, ["show", "-s", "--format=%B", commit])).stdout.split("\n");
    const cleanedLine = lines.find((line) => line.startsWith(CLEANED_PREFIX));
    return { ownBytes: lines.includes(OWN_BYTES_NOTE), cleaned: new Set<string>(cleanedLine ? JSON.parse(cleanedLine.slice(CLEANED_PREFIX.length)) : []) };
  }

  private treeLike(keptAs: { ownBytes: boolean }, staged: Staged) {
    return keptAs.ownBytes ? staged.ownBytes : staged.converted;
  }

  /** The chain the snapshots made before each got a ref: its newest snapshot holds the rest, and ages out like any. */
  private async moveChainToItsOwnRef(workspace: Workspace) {
    const chain = await this.git.run(workspace, ["rev-parse", "--verify", "--quiet", chainRefOf(workspace.id)]);
    if (chain.exitCode !== 0) return;
    await this.git.mustRun(workspace, ["update-ref", snapshotRefOf(workspace.id, chain.stdout, 0), chain.stdout]);
    await this.git.mustRun(workspace, ["update-ref", "-d", chainRefOf(workspace.id)]);
  }

  private async dropAllButNewest(workspace: Workspace) {
    const refs = await this.git.mustRun(workspace, ["for-each-ref", "--sort=-refname", "--format=%(refname)", snapshotRefsOf(workspace.id)]);
    const dropped = refs.stdout.split("\n").filter(Boolean).slice(this.keep);
    if (dropped.length > 0) await this.git.mustRun(workspace, ["update-ref", "--stdin"], { input: dropped.map((ref) => `delete ${ref}\n`).join("") });
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
   * deletes, the snapshot's entries for the paths it writes, and the submodules it leaves.
   */
  private async diffToNow(workspace: Workspace, location: Location, commit: string, keptAs: { ownBytes: boolean }): Promise<RestoreDiff> {
    const staged = await this.ownBytesStaging.stageEverything(workspace, location);
    const diff = await this.git.run(workspace, ["diff-tree", "-r", "-z", "--raw", "--relative", "--no-renames", commit, this.treeLike(keptAs, staged)]);
    const changes = changesIn(diff.stdout);
    const files = changes.filter(({ submodule }) => !submodule);
    const withStatus = (letters: string[]) => files.filter(({ status }) => letters.includes(status)).length;
    const added = files.filter(({ status }) => status === "A").map(({ path }) => path);
    const written = files.map(({ path }) => path);
    const kept = files.filter(({ fromMode }) => fromMode !== NO_FILE_MODE).map(({ fromMode, fromBlob, path }) => ({ mode: fromMode, blob: fromBlob, path }));
    return { restored: withStatus(["M", "D"]), removed: added.length, added, written, kept, submodulesLeft: changes.length - files.length };
  }

  /**
   * What the user has staged, as a commit of its own, written from a copy of their index so theirs is never locked; null
   * when git cannot write it, as during a merge conflict.
   */
  private async commitOfStaging(workspace: Workspace) {
    const copy = this.git.fileOf(workspace, ".staging.index");
    try {
      if (!(await copyFile(await this.usersIndexOf(workspace), copy).then(() => true, () => false))) return null;
      const tree = await this.git.run(workspace, ["write-tree"], { index: copy });
      if (tree.exitCode !== 0) return null;
      return (await this.git.mustRun(workspace, ["commit-tree", tree.stdout, "-m", stagingMessageOn(await this.headOf(workspace))])).stdout;
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
    await this.git.mustRun(workspace, ["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul", ...resetTo], { input: unstaged.map((path) => `${path}\0`).join(""), index });
  }

  /** An older snapshot's parent, if it has one, is the snapshot before it rather than any staging. */
  private async keepsStagingOnHead(workspace: Workspace, commit: string) {
    const parent = await this.git.run(workspace, ["show", "-s", "--format=%B", `${commit}^`]);
    return parent.exitCode === 0 && parent.stdout === stagingMessageOn(await this.headOf(workspace));
  }

  private async headOf(workspace: Workspace) {
    return (await this.git.run(workspace, ["rev-parse", "--verify", "--quiet", "HEAD"])).stdout;
  }

  private async stagedOtherwise(workspace: Workspace, index: string, paths: string[]) {
    const differing = new Set((await this.git.mustRun(workspace, ["diff", "--name-only", "-z", "--relative"], { index })).stdout.split("\0"));
    return paths.filter((path) => differing.has(path));
  }

  private async usersIndexOf(workspace: Workspace) {
    return resolve(workspace.path, (await this.git.mustRun(workspace, ["rev-parse", "--git-dir"])).stdout, "index");
  }

  /** Where the workspace's repository has its top, or null when the workspace is not in a git repository's working tree. */
  private async locate(workspace: Workspace): Promise<Location | null> {
    const located = await this.git.run(workspace, ["rev-parse", "--show-toplevel", "--show-prefix"]);
    if (located.exitCode !== 0) return null;
    const [top = "", prefix = ""] = located.stdout.split("\n");
    return { atTop: { ...workspace, path: top }, prefix };
  }
}
