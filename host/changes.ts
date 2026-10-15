import { realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, posix, resolve, sep } from "node:path";
import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import type { ChangedFile, ChangeList, ChangeScope, ChangesBase, FileChanges } from "../shared/changes.ts";
import type { StoredEvent, Workspace } from "../shared/model.ts";
import type { Checkpoints } from "./checkpoints.ts";
import { fileChangeDiff, shownPath, snippetDiff, textFileAt } from "./edit-diff.ts";
import type { Store } from "./store.ts";
import { createdSince, fileAtRevision, filesWrittenSince, headOrEmptyTree, isRepository, MAX_SCANNED_FILES, uncommittedChanges, type TreeChange } from "./working-tree.ts";

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

/** The folders that count as the workspace's, as edit approvals count them: its path, and that path with links resolved. */
async function projectDirectories(workspace: Workspace) {
  return [await realpath(workspace.path).catch(() => workspace.path), workspace.path];
}

/** A file of the project by its path in the project, with / as git writes it, so the agent's edits match git's files on Windows too. */
const projectPathOf = (path: string, directories: string[]) => {
  const shown = shownPath(path, directories);
  return shown === path ? null : shown.split(sep).join(posix.sep);
};

/** A path a page names as the project's: relative, and inside the workspace once resolved. */
function withinWorkspace(workspace: Workspace, path: string) {
  if (isAbsolute(path)) return false;
  const root = resolve(workspace.path);
  return resolve(root, path).startsWith(root + sep);
}

const byPath = (a: ChangedFile, b: ChangedFile) => a.path.localeCompare(b.path);

const agentOnly = (path: string, edits: AgentFileEdits): ChangedFile => ({ path, status: edits.deleted ? "deleted" : "modified", added: null, removed: null, byAgent: true });

interface ScopeStart {
  fromSeq: number;
  /** What the project's files are compared with, when there is something to compare them with. */
  revision: string | null;
  /** When the turn began, for a folder that is no repository: its files are told apart by when they were written. */
  since?: number;
  base: ChangesBase;
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
  ) {}

  async list(conversationId: string, scope: ChangeScope): Promise<ChangeList> {
    const workspace = this.workspaceOf(conversationId);
    const start = await this.startOf(conversationId, workspace, scope);
    if (start.base === "no-turn") return { scope, base: start.base, project: [], outside: [] };
    const directories = await projectDirectories(workspace);
    const edits = this.agentEdits(conversationId, workspace, start.fromSeq);
    const agentProjectFiles = new Map(edits.flatMap((edit) => (projectPathOf(edit.path, directories) === null ? [] : [[projectPathOf(edit.path, directories)!, edit] as const])));
    const outside = edits.filter((edit) => projectPathOf(edit.path, directories) === null).map((edit) => agentOnly(edit.path, edit));
    const { changes, truncated } = await this.treeChanges(workspace, scope, start);
    const project = changes
      ? [
          ...changes.map((change) => ({ ...change, byAgent: agentProjectFiles.has(change.path) })),
          ...(scope === "turn" ? [...agentProjectFiles].filter(([path]) => !changes.some((change) => change.path === path)).map(([path, edit]) => agentOnly(path, edit)) : []),
        ]
      : [...agentProjectFiles].map(([path, edit]) => agentOnly(path, edit));
    return { scope, base: start.base, project: project.sort(byPath), outside: outside.sort(byPath), ...(truncated && { filesCheckedAtMost: MAX_SCANNED_FILES }) };
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
    if (!start.revision) return start.since === undefined ? agentDiffs() : this.writtenSinceDiff(workspace, path, start.since, agentEdits ? agentDiffs() : null);
    const [before, after] = await Promise.all([fileAtRevision(workspace.path, start.revision, path), textFileAt(join(workspace.path, path))]);
    const unchanged = before.kind === after.kind && (before.kind !== "text" || (after.kind === "text" && before.text === after.text));
    if (unchanged && agentEdits) return agentDiffs();
    return { path, source: "files", diffs: unchanged ? [] : [fileChangeDiff(path, before, after)] };
  }

  /** A file with no earlier version to compare with: the agent's own edits to it, or all of it if it is new, or else nothing to show. */
  private async writtenSinceDiff(workspace: Workspace, path: string, since: number, agentDiffs: FileChanges | null): Promise<FileChanges> {
    if (agentDiffs) return agentDiffs;
    if (await createdSince(workspace.path, path, since)) {
      return { path, source: "files", diffs: [fileChangeDiff(path, { kind: "missing" }, await textFileAt(join(workspace.path, path)))] };
    }
    return { path, source: "files", diffs: [{ ...fileChangeDiff(path, { kind: "missing" }, { kind: "missing" }), change: "modified", hiddenBecause: "this folder is not a git repository, so there is no earlier version to compare with" }] };
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

  /** The agent's edits from `fromSeq` on, each at its absolute path, a path the agent gave relative to the workspace resolved against it. */
  private agentEdits(conversationId: string, workspace: Workspace, fromSeq: number) {
    return agentEditsIn(this.store.toolCallEventsFrom(conversationId, fromSeq)).map((edit) => ({ ...edit, path: resolve(workspace.path, edit.path) }));
  }

  private async startOf(conversationId: string, workspace: Workspace, scope: ChangeScope): Promise<ScopeStart> {
    if (scope === "uncommitted") {
      return (await isRepository(workspace.path)) ? { fromSeq: 0, revision: await headOrEmptyTree(workspace.path), base: "head" } : { fromSeq: 0, revision: null, base: "not-a-repository" };
    }
    const turn = this.store.latestTurnStart(conversationId);
    if (!turn) return { fromSeq: 0, revision: null, base: "no-turn" };
    if (!(await isRepository(workspace.path))) return { fromSeq: turn.seq, revision: null, since: turn.at, base: "turn-file-times" };
    const kept = turn.checkpoint !== null && (await this.checkpoints.keeps(workspace, turn.checkpoint));
    return kept ? { fromSeq: turn.seq, revision: turn.checkpoint, base: "turn-start" } : { fromSeq: turn.seq, revision: null, base: "turn-not-kept" };
  }

  private async treeChanges(workspace: Workspace, scope: ChangeScope, start: ScopeStart): Promise<{ changes: TreeChange[] | null; truncated: boolean }> {
    if (start.since !== undefined) return filesWrittenSince(workspace.path, start.since);
    if (!start.revision) return { changes: null, truncated: false };
    const changes = scope === "turn" ? await this.checkpoints.changesSince(workspace, start.revision) : await uncommittedChanges(workspace.path);
    return { changes, truncated: false };
  }
}
