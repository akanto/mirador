import { realpathSync } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, posix, resolve, sep } from "node:path";
import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import type { ChangedFile, ChangeList, ChangeScope, ChangesBase, FileChanges, ProjectFiles } from "../shared/changes.ts";
import type { StoredEvent, Workspace } from "../shared/model.ts";
import type { Checkpoints } from "./checkpoints.ts";
import { fileChangeDiff, shownPath, snippetDiff, textFileAt } from "./edit-diff.ts";
import type { FileBefore } from "./edit-diff.ts";
import type { Store } from "./store.ts";
import { looksLikeText, openingOf } from "./system-open.ts";
import {
  changesSinceCommitsWithin,
  changesWritten,
  createdSince,
  fileAtRevision,
  filesWritten,
  filesWrittenSince,
  headOrEmptyTree,
  ignoredFilesWritten,
  isIgnored,
  isRepository,
  MAX_SCANNED_FILES,
  projectFiles,
  uncommittedChanges,
  writtenWithin,
  type TimeWindow,
  type TreeChange,
} from "./working-tree.ts";

const FILE_CHANGING_KINDS: ToolKind[] = ["edit", "delete", "move"];

interface Snippet {
  oldText: string | null;
  newText: string;
}

/** A file the agent changed with its edit tools: its absolute path, and each edit's snippet in order. */
export interface AgentFileEdits {
  path: string;
  deleted: boolean;
  snippets: Snippet[];
}

interface ToolCallSoFar {
  kind: ToolKind | null;
  status: string | null;
  paths: Set<string>;
  snippets: Map<string, Snippet>;
}

/**
 * The files the agent's finished edit tool calls changed. Claude Code names the kind only in a tool call's first
 * update, and the paths and the diff in later ones, an Edit's diff twice with more lines around it the second time;
 * so every update of a tool call is gathered, and each file keeps the call's last diff of it.
 */
export function agentEditsIn(events: StoredEvent[]): AgentFileEdits[] {
  const calls = new Map<string, ToolCallSoFar>();
  events.forEach(({ event }) => {
    if (event.type !== "acp" || (event.update.sessionUpdate !== "tool_call" && event.update.sessionUpdate !== "tool_call_update")) return;
    const update = event.update;
    const call = calls.get(update.toolCallId) ?? { kind: null, status: null, paths: new Set(), snippets: new Map() };
    calls.set(update.toolCallId, call);
    call.kind ??= update.kind ?? null;
    call.status = update.status ?? call.status;
    (update.locations ?? []).forEach(({ path }) => call.paths.add(path));
    (update.content ?? [])
      .filter((content): content is Extract<ToolCallContent, { type: "diff" }> => content.type === "diff")
      .forEach(({ path, oldText, newText }) => {
        call.paths.add(path);
        call.snippets.set(path, { oldText: oldText ?? null, newText });
      });
  });
  const files = new Map<string, AgentFileEdits>();
  [...calls.values()]
    .filter(({ kind, status }) => kind !== null && FILE_CHANGING_KINDS.includes(kind) && status === "completed")
    .forEach((call) =>
      call.paths.forEach((path) => {
        const file = files.get(path) ?? { path, deleted: false, snippets: [] };
        files.set(path, file);
        file.deleted = call.kind === "delete";
        const snippet = call.snippets.get(path);
        if (snippet) file.snippets.push(snippet);
      }),
    );
  return [...files.values()];
}

/** The host stores a report when it reads it, which can be a little after the command it reports on wrote a file, or before. */
export const COMMAND_WINDOW_SLACK_MS = 1000;

interface CommandSoFar {
  kind: ToolKind | null;
  reportedAt: number;
  runningAt: number | null;
  endedAt: number | null;
}

/**
 * When each of the agent's commands ran, from the conversation's first message on: from when it started running,
 * which Claude Code reports after a permission was answered, else its first report, to when it completed or failed;
 * a command with neither ended with its turn, or still runs.
 */
export function commandWindows(events: StoredEvent[], turnEnds: number[], firstMessageAt: number, now: number): TimeWindow[] {
  const calls = new Map<string, CommandSoFar>();
  events.forEach(({ at, event }) => {
    if (event.type !== "acp" || (event.update.sessionUpdate !== "tool_call" && event.update.sessionUpdate !== "tool_call_update")) return;
    const { toolCallId, kind, status } = event.update;
    const call = calls.get(toolCallId) ?? { kind: null, reportedAt: at, runningAt: null, endedAt: null };
    calls.set(toolCallId, call);
    call.kind ??= kind ?? null;
    if (status === "in_progress") call.runningAt ??= at;
    if (status === "completed" || status === "failed") call.endedAt ??= at;
  });
  return [...calls.values()]
    .filter(({ kind }) => kind === "execute")
    .map(({ reportedAt, runningAt, endedAt }) => {
      const from = runningAt ?? reportedAt;
      const to = endedAt ?? turnEnds.find((at) => at >= from) ?? now;
      return { from, to: to + COMMAND_WINDOW_SLACK_MS };
    })
    .filter(({ from }) => from >= firstMessageAt)
    .map(({ from, to }) => ({ from: Math.max(from - COMMAND_WINDOW_SLACK_MS, firstMessageAt), to }));
}

/** The folders that count as the workspace's, as edit approvals count them: its path, and that path with links resolved. */
async function projectDirectories(workspace: Workspace) {
  return [await realpath(workspace.path).catch(() => workspace.path), workspace.path];
}

/** A file of the project by its path in the project, with / as git writes it, so the agent's edits match git's files on Windows too. */
const projectPathOf = (path: string, directories: string[]) => {
  const shown = shownPath(path, directories);
  return shown === path ? null : shown.split(sep).join(posix.sep);
};

/**
 * The file a path leads to, every link followed, or null when it leads nowhere. Windows also gives the file's own
 * name for a short 8.3 name, another letter case, trailing dots or spaces, or a ::$DATA stream.
 */
function realPathOf(path: string) {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** Real paths on both sides, so a workspace added through a link to its folder still holds its files. */
const isWorkspaceOrAgentFile = (realFile: string, workspace: Workspace, edits: AgentFileEdits[]) =>
  shownPath(realFile, [realPathOf(workspace.path) ?? workspace.path]) !== realFile || edits.some((edit) => realPathOf(edit.path) === realFile);

/** A path a page names as the project's: relative, and inside the workspace once resolved. */
function withinWorkspace(workspace: Workspace, path: string) {
  if (isAbsolute(path)) return false;
  const root = resolve(workspace.path);
  return resolve(root, path).startsWith(root + sep);
}

/**
 * The workspace's own side of a diff. A link shows as a link, the way git stores it: its target path is the text, so a
 * committed link shows that path and not what it leads to. A file reached through a link that leads out of the workspace
 * is refused, as its contents are not the project's to show. The file's real place is its parent folder with links
 * resolved plus its own name, so a link at the end is not followed; real paths on both sides, so a workspace whose own
 * path goes through a link still holds its files.
 */
async function workspaceFileAt(workspace: Workspace, path: string): Promise<FileBefore> {
  const file = join(workspace.path, path);
  const stats = await lstat(file).catch((error) => ((error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error)));
  if (stats === null) return { kind: "missing" };
  const realPlace = join(realPathOf(dirname(file)) ?? dirname(file), basename(file));
  if (shownPath(realPlace, [realPathOf(workspace.path) ?? workspace.path]) === realPlace)
    throw new Error(`${path} leads outside this workspace, so Mirador does not show it.`);
  if (stats.isSymbolicLink()) return { kind: "text", text: await readlink(file) };
  return textFileAt(file);
}

const byPath = (a: ChangedFile, b: ChangedFile) => a.path.localeCompare(b.path);

const agentOnly = (path: string, edits: AgentFileEdits): ChangedFile => ({ path, status: edits.deleted ? "deleted" : "modified", added: null, removed: null, byAgent: true });

/**
 * A file outside the project as the agent's edits and the disk tell it: added when the agent's first edit made it,
 * deleted once it is gone however that happened, as a script or shell command deleting it leaves no edit. Only whether
 * the file is there is looked at, never what it holds.
 */
async function outsideFile(edits: AgentFileEdits): Promise<ChangedFile> {
  const stillThere = await lstat(edits.path).then(
    () => true,
    () => false,
  );
  const status = edits.deleted || !stillThere ? "deleted" : edits.snippets[0]?.oldText === null ? "added" : "modified";
  return { ...agentOnly(edits.path, edits), status };
}

interface ScopeStart {
  fromSeq: number;
  /** What the project's files are compared with, when there is something to compare them with. */
  revision: string | null;
  /** When the turn began, for a folder that is no repository: its files are told apart by when they were written. */
  since?: number;
  /** In a session, when the agent's commands ran: a file written then is the agent's too. */
  commandWindows?: TimeWindow[];
  base: ChangesBase;
}

/** A file link leads to a file outside the workspace that the agent did not change, which opens only once the owner agrees. */
export class OutsideWorkspace extends Error {
  constructor(readonly file: string) {
    super(`${file} is neither a file of this workspace nor one the agent changed in this conversation.`);
  }
}

/**
 * The files a conversation's turn, or the workspace's uncommitted work, changed: the project's files as git sees
 * them, marked where the agent's edit tools changed them, and apart from them the files outside the project the agent
 * changed. A file's line changes come from git and the disk for the project's files, and only from the agent's own
 * snippets for the others, so a page can never read a file the agent did not write.
 */
export class Changes {
  constructor(
    private readonly store: Store,
    private readonly checkpoints: Checkpoints,
    private readonly workspaceOf: (conversationId: string) => Workspace,
    private readonly openInIdea: (file: string, line: number) => void,
    private readonly openWithDefault: (file: string) => Promise<boolean>,
    private readonly openAsText: (file: string) => Promise<boolean>,
  ) {}

  async list(conversationId: string, scope: ChangeScope): Promise<ChangeList> {
    const workspace = this.workspaceOf(conversationId);
    const start = await this.startOf(conversationId, workspace, scope);
    if (start.base === "no-turn") return { scope, base: start.base, project: [], committed: [], outside: [] };
    const directories = await projectDirectories(workspace);
    const edits = this.agentEdits(conversationId, workspace, start.fromSeq);
    const agentProjectFiles = new Map(edits.flatMap((edit) => (projectPathOf(edit.path, directories) === null ? [] : [[projectPathOf(edit.path, directories)!, edit] as const])));
    const outside = await Promise.all(edits.filter((edit) => projectPathOf(edit.path, directories) === null).map(outsideFile));
    const { changes, committedPaths, truncated } = await this.treeChanges(workspace, scope, start);
    const project = changes
      ? [
          ...changes.map((change) => ({ ...change, byAgent: agentProjectFiles.has(change.path) })),
          ...(scope !== "uncommitted" ? [...agentProjectFiles].filter(([path]) => !changes.some((change) => change.path === path)).map(([path, edit]) => agentOnly(path, edit)) : []),
        ]
      : [...agentProjectFiles].map(([path, edit]) => agentOnly(path, edit));
    const fromCommits = ({ path }: ChangedFile) => committedPaths.has(path);
    return {
      scope,
      base: start.base,
      project: project.filter((file) => !fromCommits(file)).sort(byPath),
      committed: project.filter(fromCommits).sort(byPath),
      outside: outside.sort(byPath),
      ...(truncated && { filesCheckedAtMost: MAX_SCANNED_FILES }),
    };
  }

  async files(conversationId: string): Promise<ProjectFiles> {
    const { files, truncated } = await projectFiles(this.workspaceOf(conversationId).path);
    return { paths: files, ...(truncated && { filesListedAtMost: MAX_SCANNED_FILES }) };
  }

  async diff(conversationId: string, scope: ChangeScope, path: string): Promise<FileChanges> {
    const workspace = this.workspaceOf(conversationId);
    const start = await this.startOf(conversationId, workspace, scope);
    const directories = await projectDirectories(workspace);
    const edits = this.agentEdits(conversationId, workspace, start.fromSeq);
    const agentEdits = edits.find((edit) => (isAbsolute(path) ? edit.path === path : projectPathOf(edit.path, directories) === path));
    const agentDiffs = (): FileChanges => ({ path, source: "agent", diffs: (agentEdits?.snippets ?? []).map(({ oldText, newText }) => snippetDiff(path, oldText, newText)) });
    if (isAbsolute(path)) {
      if (!agentEdits) throw new Error(`The agent did not change ${path} in this conversation.`);
      return agentDiffs();
    }
    if (!withinWorkspace(workspace, path)) throw new Error(`${path} is not a file of this workspace.`);
    if (start.commandWindows && !agentEdits && (await this.isTrackedOrUntracked(workspace, path))) {
      const { baseOf } = await changesSinceCommitsWithin(workspace.path, start.since!, start.commandWindows);
      return this.filesDiff(workspace, path, baseOf.get(path) ?? (await headOrEmptyTree(workspace.path)), null);
    }
    if (!start.revision) return start.since === undefined ? agentDiffs() : this.writtenSinceDiff(workspace, path, start.since, agentEdits ? agentDiffs() : null);
    return this.filesDiff(workspace, path, start.revision, agentEdits ? agentDiffs : null);
  }

  private async isTrackedOrUntracked(workspace: Workspace, path: string) {
    return (await isRepository(workspace.path)) && !(await isIgnored(workspace.path, path));
  }

  /** The file compared with `revision`, or the agent's own edits to it where it is as it was then. */
  private async filesDiff(workspace: Workspace, path: string, revision: string, agentDiffs: (() => FileChanges) | null): Promise<FileChanges> {
    const [before, after] = await Promise.all([fileAtRevision(workspace.path, revision, path), workspaceFileAt(workspace, path)]);
    const unchanged = before.kind === after.kind && (before.kind !== "text" || (after.kind === "text" && before.text === after.text));
    if (unchanged && agentDiffs) return agentDiffs();
    return { path, source: "files", diffs: unchanged ? [] : [fileChangeDiff(path, before, after)] };
  }

  /** A file with no earlier version to compare with: the agent's own edits to it, or all of it if it is new, or else nothing to show. */
  private async writtenSinceDiff(workspace: Workspace, path: string, since: number, agentDiffs: FileChanges | null): Promise<FileChanges> {
    if (agentDiffs) return agentDiffs;
    if (await createdSince(workspace.path, path, since)) {
      return { path, source: "files", diffs: [fileChangeDiff(path, { kind: "missing" }, await workspaceFileAt(workspace, path))] };
    }
    const noEarlierVersion = (await isRepository(workspace.path)) ? "git ignores this file, so there is no earlier version to compare with" : "this folder is not a git repository, so there is no earlier version to compare with";
    return { path, source: "files", diffs: [{ ...fileChangeDiff(path, { kind: "missing" }, { kind: "missing" }), change: "modified", hiddenBecause: noEarlierVersion }] };
  }

  /** Opens a file of the project, or one the agent changed anywhere in this conversation, in IntelliJ IDEA. */
  async openInEditor(conversationId: string, path: string, line: number) {
    const workspace = this.workspaceOf(conversationId);
    if (!Number.isInteger(line) || line < 1) throw new Error(`${line} is not a line number.`);
    if (isAbsolute(path)) {
      const changedByAgent = this.agentEdits(conversationId, workspace, 0).some((edit) => edit.path === normalize(path));
      if (!changedByAgent) throw new Error(`The agent did not change ${path} in this conversation.`);
      return this.openInIdea(normalize(path), line);
    }
    if (!withinWorkspace(workspace, path)) throw new Error(`${path} is not a file of this workspace.`);
    this.openInIdea(join(resolve(workspace.path), path), line);
  }

  /**
   * Opens a file of the project, or one the agent changed in this conversation, with the system's default program, or
   * as text if it is a script or no program is set for it; any other file only once the owner agreed. A link is checked
   * and opened as the file it leads to, as the system would open that file whatever the link's name.
   */
  async openFile(conversationId: string, path: string, ownerAgreed = false) {
    const workspace = this.workspaceOf(conversationId);
    const realFile = realPathOf(isAbsolute(path) ? normalize(path) : resolve(workspace.path, path));
    if (realFile === null) throw new Error(isAbsolute(path) ? `${path} does not exist.` : `${path} does not exist in ${workspace.path}.`);
    if (!ownerAgreed && !isWorkspaceOrAgentFile(realFile, workspace, this.agentEdits(conversationId, workspace, 0))) throw new OutsideWorkspace(realFile);
    const opening = openingOf(realFile);
    if (opening === "refused") throw new Error(`${path} would run as a program, so Mirador does not open it.`);
    if (opening === "default") {
      if (await this.openWithDefault(realFile)) return;
      if (!(await looksLikeText(realFile))) throw new Error(`No program is set to open ${path}, and it is not text, so Mirador cannot open it.`);
    }
    if (!(await this.openAsText(realFile))) throw new Error(`Mirador could not open ${path} as text.`);
  }

  /** The agent's edits from `fromSeq` on, each at its absolute path, a path the agent gave relative to the workspace resolved against it. */
  private agentEdits(conversationId: string, workspace: Workspace, fromSeq: number) {
    return agentEditsIn(this.store.toolCallEventsFrom(conversationId, fromSeq)).map((edit) => ({ ...edit, path: resolve(workspace.path, edit.path) }));
  }

  private async startOf(conversationId: string, workspace: Workspace, scope: ChangeScope): Promise<ScopeStart> {
    if (scope === "session") return this.sessionStart(conversationId);
    if (scope === "uncommitted") {
      return (await isRepository(workspace.path)) ? { fromSeq: 0, revision: await headOrEmptyTree(workspace.path), base: "head" } : { fromSeq: 0, revision: null, base: "not-a-repository" };
    }
    const turn = this.store.latestTurnStart(conversationId);
    if (!turn) return { fromSeq: 0, revision: null, base: "no-turn" };
    if (!(await isRepository(workspace.path))) return { fromSeq: turn.seq, revision: null, since: turn.at, base: "turn-file-times" };
    const kept = turn.checkpoint !== null && (await this.checkpoints.keeps(workspace, turn.checkpoint));
    return kept ? { fromSeq: turn.seq, revision: turn.checkpoint, base: "turn-start" } : { fromSeq: turn.seq, revision: null, base: "turn-not-kept" };
  }

  /**
   * From the conversation's first message: a session holds everything the agent and its scripts wrote after it. Before
   * one, only the agent's edits count, such as those of a continued session's replayed history.
   */
  private sessionStart(conversationId: string): ScopeStart {
    const firstMessageAt = this.store.firstMessageAt(conversationId);
    if (firstMessageAt === null) return { fromSeq: 0, revision: null, base: "session" };
    const windows = commandWindows(this.store.toolCallEventsFrom(conversationId, 0), this.store.turnEndTimes(conversationId), firstMessageAt, Date.now());
    return { fromSeq: 0, revision: null, since: firstMessageAt, commandWindows: windows, base: "session" };
  }

  /**
   * The files written while the agent's commands ran: in a repository, those git lists as uncommitted, those its
   * excludes hide, and those of the commits made then, each compared with what it was before; a file in a commit counts
   * from before its earliest one.
   */
  private async writtenByCommands(workspace: Workspace, since: number, windows: TimeWindow[]): Promise<{ changes: TreeChange[]; truncated: boolean }> {
    if (windows.length === 0) return { changes: [], truncated: false };
    const counts = writtenWithin(windows);
    if (!(await isRepository(workspace.path))) return filesWritten(workspace.path, counts, MAX_SCANNED_FILES);
    const [uncommitted, ignored, committed] = await Promise.all([
      uncommittedChanges(workspace.path).then((changes) => changesWritten(workspace.path, changes ?? [], counts)),
      ignoredFilesWritten(workspace.path, counts, MAX_SCANNED_FILES),
      changesSinceCommitsWithin(workspace.path, since, windows),
    ]);
    const byPath = new Map([...ignored.changes, ...uncommitted, ...committed.changes].map((change) => [change.path, change]));
    return { changes: [...byPath.values()], truncated: ignored.truncated };
  }

  private async treeChanges(workspace: Workspace, scope: ChangeScope, start: ScopeStart): Promise<{ changes: TreeChange[] | null; committedPaths: Set<string>; truncated: boolean }> {
    const noCommits = new Set<string>();
    if (start.commandWindows) return { ...(await this.writtenByCommands(workspace, start.since!, start.commandWindows)), committedPaths: noCommits };
    if (start.since !== undefined) return { ...(await filesWrittenSince(workspace.path, start.since, MAX_SCANNED_FILES)), committedPaths: noCommits };
    if (!start.revision) return { changes: null, committedPaths: noCommits, truncated: false };
    if (scope !== "turn") return { changes: await uncommittedChanges(workspace.path), committedPaths: noCommits, truncated: false };
    const sinceTurnStart = await this.checkpoints.changesSince(workspace, start.revision);
    return { changes: sinceTurnStart?.changes ?? null, committedPaths: sinceTurnStart?.committedPaths ?? noCommits, truncated: false };
  }
}
