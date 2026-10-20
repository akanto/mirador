import type { EditDiff } from "./review.ts";

/** This turn: since the files as they were when the turn began. Uncommitted: since the repository's HEAD. Session: the agent's edits since the conversation began, and the git-ignored files written since its first message, or any file outside a repository. */
export const changeScopes = ["turn", "session", "uncommitted"] as const;
export type ChangeScope = (typeof changeScopes)[number];

export type ChangeStatus = "added" | "modified" | "deleted";

/** A file that differs from what its scope compares it with. */
export interface ChangedFile {
  /** Relative to the workspace for a file of the project, absolute for any other. */
  path: string;
  status: ChangeStatus;
  /** Null for a binary file, and for a file that only the agent's own snippets describe. */
  added: number | null;
  removed: number | null;
  /** Whether this conversation's agent changed it with its edit tools, within the scope. */
  byAgent: boolean;
}

/**
 * What the project's files were compared with. Without the files of the turn's start or a repository to compare
 * with, the project's list is the agent's own edits; in a folder that is no repository, a turn's list is also the files
 * written since the turn began.
 */
export type ChangesBase = "head" | "turn-start" | "turn-file-times" | "no-turn" | "turn-not-kept" | "not-a-repository" | "session";

export interface ChangeList {
  scope: ChangeScope;
  base: ChangesBase;
  project: ChangedFile[];
  /** In a turn, the project's files that commits since the turn began changed, such as a pull's or the agent's own, apart from the rest. */
  committed: ChangedFile[];
  outside: ChangedFile[];
  /** Set when the folder held more files than were checked, to how many were: the list may lack some. */
  filesCheckedAtMost?: number;
}

/** A file's line changes: the file compared with the scope's base, or else the agent's edits to it, one by one. */
export interface FileChanges {
  path: string;
  source: "files" | "agent";
  diffs: EditDiff[];
}
