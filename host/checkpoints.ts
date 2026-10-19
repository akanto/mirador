import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { RestorePlan, Workspace } from "../shared/model.ts";
import { treeChangesIn, type TreeChange } from "./working-tree.ts";

/** Where snapshots hung, one after another, before each got a ref of its own. */
const chainRefOf = (workspaceId: string) => `refs/mirador/${workspaceId}`;
const snapshotRefsOf = (workspaceId: string) => `refs/mirador/turns/${workspaceId}/`;
/** Named by when it was taken, so the names sort oldest first; the chain from before sorts ahead of every snapshot. */
const snapshotRefOf = (workspaceId: string, commit: string, takenAt: number) => `${snapshotRefsOf(workspaceId)}${String(takenAt).padStart(16, "0")}-${commit}`;

export const SNAPSHOTS_KEPT = 100;

const SUBMODULE_MODE = "160000";
const SYMLINK_MODE = "120000";
const EXECUTABLE_MODE = "100755";
const FILE_MODES = new Set(["100644", EXECUTABLE_MODE]);
/** The mode git gives the side of a change that has no file; given to update-index, it takes the path out. */
const NO_FILE_MODE = "000000";

/**
 * git's `-z --raw` output: each change's modes, objects and status (":100644 100644 <old> <new> M"), then its path, each
 * ended by NUL, with names left as they are.
 */
function changesIn(output: string) {
  const fields = output.split("\0").filter(Boolean);
  return fields.flatMap((field, index) => {
    if (index % 2 === 1) return [];
    const [fromMode = "", toMode = "", fromBlob = "", toBlob = "", status = ""] = field.slice(1).split(" ");
    return [{ status, path: fields[index + 1] ?? "", fromMode, toMode, fromBlob, toBlob, submodule: fromMode === SUBMODULE_MODE || toMode === SUBMODULE_MODE }];
  });
}

/** `git ls-files -s -z`: each entry's mode, object and stage, a tab, and its path, which may hold tabs of its own. */
function entriesIn(output: string) {
  return output.split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const [mode = "", blob = ""] = line.slice(0, tab).split(" ");
    return { mode, blob, path: line.slice(tab + 1) };
  });
}

/** `git check-attr -z`: a path, an attribute and its value, again and again. */
function attributesIn(output: string) {
  const fields = output.split("\0");
  const attributes = new Map<string, Map<string, string>>();
  Array.from({ length: Math.floor(fields.length / 3) }, (_, index) => fields.slice(index * 3, index * 3 + 3)).forEach(([path = "", attribute = "", value = ""]) => {
    attributes.set(path, (attributes.get(path) ?? new Map()).set(attribute, value));
  });
  return attributes;
}

/** The entries whose own bytes are another blob than the one git stores. */
function differingOf(entries: Entry[], ownBlobs: Map<string, string>) {
  return entries.flatMap((entry) => {
    const blob = ownBlobs.get(entry.path);
    return blob !== undefined && blob !== entry.blob ? [{ ...entry, blob }] : [];
  });
}

const CONVERTING_ATTRIBUTES = ["text", "eol", "crlf", "ident", "working-tree-encoding"];
const NOT_SET = new Set(["unspecified", "unset"]);

/** A path git reported names a file of this workspace; any other path is not ours to delete. */
function withinWorkspace(workspace: Workspace, path: string) {
  const root = resolve(workspace.path);
  return resolve(root, path).startsWith(root + sep);
}
const SNAPSHOT_MESSAGE = "mirador: the files at the start of a turn";
/** Marks a snapshot that holds each file's own bytes: one without it holds them as git's attributes converted them. */
const OWN_BYTES_NOTE = "Each file is kept as its own bytes, but those a filter cleans, which are kept as git stores them.";
const CLEANED_PREFIX = "Cleaned by a filter: ";
const snapshotMessageOf = (cleaned: string[]) => [SNAPSHOT_MESSAGE, "", OWN_BYTES_NOTE, ...(cleaned.length > 0 ? [`${CLEANED_PREFIX}${JSON.stringify(cleaned)}`] : [])].join("\n");
/** Names the HEAD the staging was taken on: staging put back onto another HEAD would stage a revert of what was committed since. */
const stagingMessageOn = (head: string) => `mirador: the staged files at the start of a turn\n\nHEAD ${head || "unborn"}`;
/** Mirador's own commits need no identity or signing setup from the user's git config. */
export const IDENTITY = ["-c", "user.name=mirador", "-c", "user.email=mirador@localhost", "-c", "commit.gpgsign=false"];
const WITHOUT_AUTOCRLF = ["-c", "core.autocrlf=false"];

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
 * git add stores a file as the repository's attributes ask: line endings converted, filters such as Git LFS run. Our
 * staging index keeps that form, so git can tell from the files' stat data which ones changed; a second index holds
 * each file's own bytes in its place, and the snapshot is that index's tree. A file a filter cleans stays in the
 * filter's form, so a large file LFS keeps elsewhere does not land in the repository, and comes back through the
 * filter. Snapshots taken before hold the converted form, and a restore of one writes the files it puts back the way
 * git checks them out.
 *
 * A workspace that is not a git repository has no snapshots, and so no undo.
 */
type GitOptions = { input?: string; index?: string; ownIndex?: string; pathspecMagic?: boolean };

/** Where git runs on paths from the repository's top, and the workspace folder's own path from there. */
type Location = { atTop: Workspace; prefix: string };

/** The tree of our staging index, the tree of the files' own bytes, and the paths a filter cleans. */
type Staged = { converted: string; ownBytes: string; cleaned: string[] };

/**
 * What a stage left: our staging index's file as git last wrote it, and what it staged. git writes an index through a
 * lock file it renames, so a write by anyone else gives the file another identity.
 */
type OwnBytesState = Staged & { version: typeof OWN_BYTES_STATE_VERSION; staging: FileIdentity | null };
type FileIdentity = { ino: number; size: number; mtimeMs: number };
const OWN_BYTES_STATE_VERSION = 1;

/** A state of another version, or one that cannot be read, is no state: the next stage builds the index again. */
function stateIn(text: string): OwnBytesState | null {
  try {
    const state = JSON.parse(text) as OwnBytesState;
    return state.version === OWN_BYTES_STATE_VERSION ? state : null;
  } catch {
    return null;
  }
}

type Entry = { mode: string; blob: string; path: string };
type Change = ReturnType<typeof changesIn>[number];
type RestoreDiff = { restored: number; removed: number; added: string[]; written: string[]; kept: Entry[]; submodulesLeft: number };

export class Checkpoints {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataDir: string,
    private readonly keep = SNAPSHOTS_KEPT,
  ) {}

  /** The workspace's files as they are now, or null when it is not a git repository. */
  snapshot(workspace: Workspace): Promise<string | null> {
    return this.inOrder(workspace.id, async () => {
      const location = await this.locate(workspace);
      if (!location) return null;
      const { ownBytes, cleaned } = await this.stageEverything(workspace, location);
      const staging = await this.commitOfStaging(workspace);
      const commit = (await this.mustGit(workspace, ["commit-tree", ownBytes, ...(staging ? ["-p", staging] : []), "-F", "-"], { input: snapshotMessageOf(cleaned) })).stdout;
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
      const location = await this.locate(workspace);
      if (!location) return null;
      const keptAs = await this.keptAs(workspace, commit);
      const now = this.treeLike(keptAs, await this.stageEverything(workspace, location));
      const diff = async (format: string) => (await this.mustGit(workspace, ["diff-tree", "-r", "-z", "--relative", "--no-renames", format, commit, now])).stdout;
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
      if (keptAs.ownBytes) await this.putBackOwnBytes(workspace, location, plan, keptAs.cleaned);
      else await this.checkOutAsBefore(workspace, commit, plan);
      await this.restoreStaging(workspace, commit, plan.written);
      return { restored: plan.restored, removed: plan.removed, ...(plan.submodulesLeft > 0 && { submodulesLeft: plan.submodulesLeft }) };
    });
  }

  /** Whether the snapshot holds the files' own bytes, and which of them, by their path from the repository's top, a filter cleaned. */
  private async keptAs(workspace: Workspace, commit: string) {
    const lines = (await this.git(workspace, ["show", "-s", "--format=%B", commit])).stdout.split("\n");
    const cleanedLine = lines.find((line) => line.startsWith(CLEANED_PREFIX));
    return { ownBytes: lines.includes(OWN_BYTES_NOTE), cleaned: new Set<string>(cleanedLine ? JSON.parse(cleanedLine.slice(CLEANED_PREFIX.length)) : []) };
  }

  private treeLike(keptAs: { ownBytes: boolean }, staged: Staged) {
    return keptAs.ownBytes ? staged.ownBytes : staged.converted;
  }

  /**
   * Writes back the files the snapshot holds as their own bytes, and through their filter those it holds cleaned. Every
   * file is read before any is touched, so a snapshot git can no longer read fails with the workspace as it was.
   */
  private async putBackOwnBytes(workspace: Workspace, location: Location, plan: RestoreDiff, cleaned: Set<string>) {
    const entries = plan.kept.filter(({ path }) => withinWorkspace(workspace, path));
    const contents = await this.contentsOf(workspace, location, entries, (path) => cleaned.has(location.prefix + path));
    await this.deleteFiles(workspace, plan.added);
    const linksAsLinks = entries.some(({ mode }) => mode === SYMLINK_MODE) && (await this.writesLinks(workspace));
    for (const entry of entries) await this.putBackFile(workspace, entry, contents.get(entry.path)!, linksAsLinks);
  }

  /**
   * Like git's own checkout of a file: a file or link where a folder of its path should be makes way for the folder, and
   * whatever stands at the path itself, a folder and what git ignores in it included, makes way for the file.
   */
  private async putBackFile(workspace: Workspace, { mode, path }: Entry, bytes: Uint8Array, linksAsLinks: boolean) {
    const full = join(workspace.path, path);
    await this.makeFoldersUpTo(workspace.path, dirname(full));
    await rm(full, { recursive: true, force: true });
    if (mode === SYMLINK_MODE && linksAsLinks) await symlink(new TextDecoder().decode(bytes), full);
    else await writeFile(full, bytes, { mode: mode === EXECUTABLE_MODE ? 0o777 : 0o666 });
  }

  private async makeFoldersUpTo(root: string, folder: string) {
    let at = root;
    for (const name of relative(root, folder).split(sep).filter(Boolean)) {
      at = join(at, name);
      const found = await lstat(at).catch(() => null);
      if (found?.isDirectory()) continue;
      if (found) await rm(at, { force: true });
      await mkdir(at);
    }
  }

  private async writesLinks(workspace: Workspace) {
    return (await this.git(workspace, ["config", "--type=bool", "core.symlinks"])).stdout !== "false";
  }

  /** Each entry's bytes by its path: the blobs held as they are in one `git cat-file` call, the cleaned ones through their filter. */
  private async contentsOf(workspace: Workspace, { atTop, prefix }: Location, entries: Entry[], isCleaned: (path: string) => boolean) {
    const throughFilter = ({ mode, path }: Entry) => mode !== SYMLINK_MODE && isCleaned(path);
    const asTheyAre = entries.filter((entry) => !throughFilter(entry));
    const blobs = await this.blobsOf(workspace, [...new Set(asTheyAre.map(({ blob }) => blob))]);
    const contents = new Map(asTheyAre.map(({ blob, path }) => [path, blobs.get(blob)!]));
    for (const { blob, path } of entries.filter(throughFilter)) {
      contents.set(path, (await this.mustRun(atTop, ["cat-file", "--filters", `--path=${prefix}${path}`, blob])).stdout);
    }
    return contents;
  }

  /**
   * The blobs' bytes from one `git cat-file --batch` call, keyed by blob; each answer is a header line naming the blob's
   * size, the bytes themselves, and a newline.
   */
  private async blobsOf(workspace: Workspace, blobs: string[]) {
    const contents = new Map<string, Uint8Array>();
    if (blobs.length === 0) return contents;
    const { stdout } = await this.mustRun(workspace, ["cat-file", "--batch"], { input: `${blobs.join("\n")}\n` });
    const decoder = new TextDecoder();
    let at = 0;
    for (const blob of blobs) {
      const headerEnd = stdout.indexOf(0x0a, at);
      const [, type = "", size = ""] = decoder.decode(stdout.subarray(at, headerEnd === -1 ? stdout.byteLength : headerEnd)).split(" ");
      if (headerEnd === -1 || type !== "blob") throw new Error(`git can no longer read the snapshot's copy of ${blob} in ${workspace.path}`);
      contents.set(blob, stdout.subarray(headerEnd + 1, headerEnd + 1 + Number(size)));
      at = headerEnd + 1 + Number(size) + 1;
    }
    return contents;
  }

  /**
   * A snapshot from before files were kept as their own bytes holds them converted, so the files it puts back are checked
   * out as git does, from an index of their own: ours keeps the stat data that saves hashing every file again.
   */
  private async checkOutAsBefore(workspace: Workspace, commit: string, plan: RestoreDiff) {
    await this.deleteFiles(workspace, plan.added);
    if (plan.kept.length === 0) return;
    const checkout = this.fileOf(workspace, ".restore.index");
    try {
      await rm(checkout, { force: true });
      await this.mustGit(workspace, ["read-tree", commit], { ownIndex: checkout });
      await this.mustGit(workspace, ["checkout-index", "-f", "-z", "--stdin"], { ownIndex: checkout, input: plan.kept.map(({ path }) => `${path}\0`).join("") });
    } finally {
      await rm(checkout, { force: true });
    }
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
   * deletes, the snapshot's entries for the paths it writes, and the submodules it leaves.
   */
  private async diffToNow(workspace: Workspace, location: Location, commit: string, keptAs: { ownBytes: boolean }): Promise<RestoreDiff> {
    const staged = await this.stageEverything(workspace, location);
    const diff = await this.git(workspace, ["diff-tree", "-r", "-z", "--raw", "--relative", "--no-renames", commit, this.treeLike(keptAs, staged)]);
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

  /** Where the workspace's repository has its top, or null when the workspace is not in a git repository's working tree. */
  private async locate(workspace: Workspace): Promise<Location | null> {
    const located = await this.git(workspace, ["rev-parse", "--show-toplevel", "--show-prefix"]);
    if (located.exitCode !== 0) return null;
    const [top = "", prefix = ""] = located.stdout.split("\n");
    return { atTop: { ...workspace, path: top }, prefix };
  }

  /**
   * Writes the working tree into our index, which git compares against the files it hashed last time, and brings the
   * files' own bytes up to date with it. A nested git repository with no commit yet makes git refuse the whole add, so
   * those stay out of the snapshot.
   *
   * Only the files the add changed, and those whose stat data says they changed though git stores them as before, as an
   * edit of nothing but line endings does, are hashed again. While no file's own bytes differ from what git stores, the
   * staging index's tree is theirs too, with no second index to keep. The state that says what the last stage left is
   * taken away while a stage runs, so one that fails or never ends leaves the next to work it all out again.
   */
  private async stageEverything(workspace: Workspace, location: Location): Promise<Staged> {
    const state = await this.takeOwnBytesState(workspace);
    const upToDate = state !== null && (await this.leftAsItWas(workspace, state));
    const beforeAdd = this.fileOf(workspace, ".before-add.index");
    if (upToDate) await copyFile(this.fileOf(workspace, ".index"), beforeAdd);
    const [statChanged, added] = await Promise.all([upToDate ? this.statChangedIn(workspace, beforeAdd) : Promise.resolve([]), this.addEverything(workspace)]);
    if (added.exitCode !== 0) {
      if (state) await this.putOwnBytesState(workspace, state);
      throw new Error(`git add failed in ${workspace.path}: ${added.stderr || added.stdout}`);
    }
    const converted = (await this.mustGit(workspace, ["write-tree"])).stdout;
    const staged = upToDate ? await this.followChanges(workspace, location, state, converted, statChanged) : await this.ownBytesFromScratch(workspace, location, converted);
    await this.putOwnBytesState(workspace, { ...staged, version: OWN_BYTES_STATE_VERSION, staging: await this.identityOf(this.fileOf(workspace, ".index")) });
    return staged;
  }

  private async addEverything(workspace: Workspace) {
    const withoutCommit = await this.nestedRepositoriesWithNoCommit(workspace);
    const excludes = withoutCommit.map((entry) => `:(exclude,literal)${entry}`);
    return this.git(workspace, ["add", "-A", "--", ".", ...excludes], { pathspecMagic: true });
  }

  /** Whether our staging index is the one the last stage left, and the index of own bytes is there if that stage needed one. */
  private async leftAsItWas(workspace: Workspace, state: OwnBytesState) {
    const staging = await this.identityOf(this.fileOf(workspace, ".index"));
    if (staging === null || JSON.stringify(staging) !== JSON.stringify(state.staging)) return false;
    return state.ownBytes === state.converted || (await this.identityOf(this.fileOf(workspace, ".own-bytes.index"))) !== null;
  }

  private async identityOf(file: string): Promise<FileIdentity | null> {
    const found = await stat(file).catch(() => null);
    return found && { ino: found.ino, size: found.size, mtimeMs: found.mtimeMs };
  }

  /** The files whose stat data differs from the copy of our index taken before the add, which runs meanwhile. */
  private async statChangedIn(workspace: Workspace, beforeAdd: string) {
    try {
      return changesIn((await this.mustGit(workspace, ["diff-files", "-z", "--raw"], { ownIndex: beforeAdd })).stdout);
    } finally {
      await rm(beforeAdd, { force: true });
    }
  }

  /** What the add changed, and the bytes of the files whose stat data changed, brought into the files' own bytes. */
  private async followChanges(workspace: Workspace, { atTop }: Location, last: Staged, converted: string, statChanged: Change[]): Promise<Staged> {
    const changed = converted === last.converted ? [] : changesIn((await this.mustGit(workspace, ["diff-tree", "-r", "-z", "--raw", "--no-renames", last.converted, converted])).stdout);
    const changedPaths = new Set(changed.map(({ path }) => path));
    const entries = [
      ...changed.map(({ toMode, toBlob, path }) => ({ mode: toMode, blob: toBlob, path })),
      ...statChanged.filter(({ path }) => !changedPaths.has(path)).map(({ fromMode, fromBlob, path }) => ({ mode: fromMode, blob: fromBlob, path })),
    ];
    if (entries.length === 0) return { ...last, converted };
    const { ownBlobs, cleaned } = await this.ownBytesOf(atTop, entries);
    const touched = new Set(entries.map(({ path }) => path));
    const allCleaned = [...last.cleaned.filter((path) => !touched.has(path)), ...cleaned].sort();
    const ownBytes =
      last.ownBytes === last.converted
        ? await this.ownBytesOver(workspace, atTop, converted, differingOf(entries, ownBlobs))
        : await this.updatedOwnBytes(workspace, atTop, entries.map((entry) => ({ ...entry, blob: ownBlobs.get(entry.path) ?? entry.blob })));
    return { converted, ownBytes, cleaned: allCleaned };
  }

  /** The files' own bytes worked out from every file of our staging index, git's conversions looked up for each. */
  private async ownBytesFromScratch(workspace: Workspace, { atTop }: Location, converted: string): Promise<Staged> {
    const entries = entriesIn((await this.mustGit(atTop, ["ls-files", "-s", "-z"])).stdout);
    const { ownBlobs, cleaned } = await this.ownBytesOf(atTop, entries);
    return { converted, ownBytes: await this.ownBytesOver(workspace, atTop, converted, differingOf(entries, ownBlobs)), cleaned: cleaned.sort() };
  }

  /** The tree of the staging tree with the files whose own bytes differ in their place, held by an index of its own from now on. */
  private async ownBytesOver(workspace: Workspace, atTop: Workspace, converted: string, differing: Entry[]) {
    if (differing.length === 0) return converted;
    await this.mustGit(workspace, ["read-tree", converted], { ownIndex: this.fileOf(workspace, ".own-bytes.index") });
    return this.updatedOwnBytes(workspace, atTop, differing);
  }

  /** Entries go into the index of own bytes as given, or out where git's mode for them says there is no file. */
  private async updatedOwnBytes(workspace: Workspace, atTop: Workspace, entries: Entry[]) {
    const ownIndex = this.fileOf(workspace, ".own-bytes.index");
    const input = entries.map(({ mode, blob, path }) => `${mode} ${blob}\t${path}\0`).join("");
    await this.mustGit(atTop, ["update-index", "-z", "--index-info"], { ownIndex, input });
    return (await this.mustGit(workspace, ["write-tree"], { ownIndex })).stdout;
  }

  /**
   * The blob of their own bytes for the files git may have converted, by path, and the paths a filter cleans, which keep
   * git's blob.
   */
  private async ownBytesOf(atTop: Workspace, entries: Entry[]) {
    const { cleaned, converted } = await this.conversionsOf(atTop, entries.filter(({ mode }) => FILE_MODES.has(mode)).map(({ path }) => path));
    const ownBlobs = await this.ownBlobsOf(atTop, [...converted].filter((path) => !cleaned.has(path)));
    return { ownBlobs, cleaned: [...cleaned] };
  }

  /**
   * Which of the files, by their path from the repository's top, a configured filter cleans, and which git's attributes
   * may convert in other ways, as line endings.
   */
  private async conversionsOf(atTop: Workspace, paths: string[]) {
    if (paths.length === 0) return { cleaned: new Set<string>(), converted: new Set<string>() };
    const input = paths.map((path) => `${path}\0`).join("");
    const listed = new TextDecoder().decode((await this.mustRun(atTop, ["check-attr", "-z", "--stdin", "filter", ...CONVERTING_ATTRIBUTES], { input })).stdout);
    const attributes = [...attributesIn(listed)];
    const filtering = attributes.some(([, values]) => !NOT_SET.has(values.get("filter") ?? "unspecified"));
    const drivers = filtering ? await this.cleaningFilters(atTop) : new Set<string>();
    const cleaned = attributes.filter(([, values]) => drivers.has(values.get("filter") ?? "")).map(([path]) => path);
    const converted = attributes.filter(([, values]) => CONVERTING_ATTRIBUTES.some((attribute) => !NOT_SET.has(values.get(attribute) ?? "unspecified"))).map(([path]) => path);
    return { cleaned: new Set(cleaned), converted: new Set(converted) };
  }

  /** The filters git's config gives a command to clean files with; one named in .gitattributes but not configured cleans nothing. */
  private async cleaningFilters(workspace: Workspace) {
    const listed = await this.git(workspace, ["config", "-z", "--get-regexp", "^filter\\..*\\.(clean|process)$"]);
    const keys = listed.stdout.split("\0").filter(Boolean).map((entry) => entry.split("\n")[0] ?? "");
    return new Set(keys.map((key) => key.slice("filter.".length, key.lastIndexOf("."))));
  }

  /**
   * The blob of each file's own bytes, written into the repository, by path. git hashes a batch at once, but reads its
   * lines unquoting one that begins with a double quote and dropping a carriage return that ends one, so such names, and
   * names with a newline, go one by one. A file gone since the add keeps the blob the add gave it.
   */
  private async ownBlobsOf(atTop: Workspace, paths: string[]) {
    const hash = ["hash-object", "-w", "--no-filters"];
    const misreadInABatch = (path: string) => /^"|[\n\r]/.test(path);
    const oneByOne = paths.filter(misreadInABatch);
    const batchable = paths.filter((path) => !misreadInABatch(path));
    const blobs = new Map<string, string>();
    const hashBatch = async (batch: string[]) => {
      if (batch.length === 0) return true;
      const hashed = await this.git(atTop, [...hash, "--stdin-paths"], { input: `${batch.join("\n")}\n` });
      if (hashed.exitCode !== 0) return false;
      hashed.stdout.split("\n").forEach((blob, index) => blobs.set(batch[index]!, blob));
      return true;
    };
    if (!(await hashBatch(batchable))) await hashBatch(await this.stillFiles(atTop, batchable));
    for (const path of oneByOne) {
      const hashed = await this.git(atTop, [...hash, "--", path]);
      if (hashed.exitCode === 0) blobs.set(path, hashed.stdout);
    }
    return blobs;
  }

  private async stillFiles(atTop: Workspace, paths: string[]) {
    const found = await Promise.all(paths.map(async (path) => ((await lstat(join(atTop.path, path)).catch(() => null))?.isFile() ? [path] : [])));
    return found.flat();
  }

  private async takeOwnBytesState(workspace: Workspace) {
    const file = this.fileOf(workspace, ".own-bytes.json");
    const text = await readFile(file, "utf8").catch(() => null);
    await rm(file, { force: true });
    return text === null ? null : stateIn(text);
  }

  private async putOwnBytesState(workspace: Workspace, state: OwnBytesState) {
    const file = this.fileOf(workspace, ".own-bytes.json");
    await writeFile(`${file}.new`, JSON.stringify(state));
    await rename(`${file}.new`, file);
  }

  private fileOf(workspace: Workspace, suffix: string) {
    return join(this.dataDir, "checkpoints", `${workspace.id}${suffix}`);
  }

  /**
   * The nested git repositories with no commit of their own: git lists each untracked repository as one folder entry,
   * and one whose HEAD cannot be read has no commit to record as a gitlink, unlike a committed one.
   */
  private async nestedRepositoriesWithNoCommit(workspace: Workspace) {
    const listed = await this.mustGit(workspace, ["ls-files", "-o", "--exclude-standard", "-z"]);
    const repositories = listed.stdout.split("\0").filter((entry) => entry.endsWith("/"));
    const withoutCommit: string[] = [];
    for (const repository of repositories) {
      if ((await this.git(workspace, ["-C", repository, "rev-parse", "--verify", "--quiet", "HEAD"])).exitCode !== 0) withoutCommit.push(repository);
    }
    return withoutCommit;
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

  private async git(workspace: Workspace, args: string[], options: GitOptions = {}) {
    const { stdout, stderr, exitCode } = await this.run(workspace, args, options);
    return { stdout: new TextDecoder().decode(stdout).trim(), stderr, exitCode };
  }

  /** Like `mustGit`, with git's output as the bytes it wrote. */
  private async mustRun(workspace: Workspace, args: string[], options: GitOptions = {}) {
    const result = await this.run(workspace, args, options);
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${workspace.path}: ${result.stderr}`);
    return result;
  }

  /**
   * On our staging index unless told another; paths given to git are taken as they are, never as patterns, unless
   * `pathspecMagic` asks for git's own matching, which an exclude pathspec needs. Files go into our own indexes and back
   * out without core.autocrlf's conversion, while the user's index is compared with their own.
   */
  private async run(workspace: Workspace, args: string[], { input, index, ownIndex, pathspecMagic }: GitOptions = {}) {
    await mkdir(join(this.dataDir, "checkpoints"), { recursive: true });
    const conversion = index === undefined ? WITHOUT_AUTOCRLF : [];
    const child = Bun.spawn(["git", "-C", workspace.path, ...IDENTITY, ...conversion, ...args], {
      env: { ...process.env, GIT_INDEX_FILE: index ?? ownIndex ?? this.fileOf(workspace, ".index"), GIT_LITERAL_PATHSPECS: pathspecMagic ? "0" : "1" },
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr: stderr.trim(), exitCode };
  }
}
