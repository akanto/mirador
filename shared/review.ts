export type FindingSeverity = "blocker" | "issue" | "question" | "nit";
export type FindingCheck = "confirmed" | "plausible";
export type FindingDecision = "keep" | "drop";

export const findingSeverities: FindingSeverity[] = ["blocker", "issue", "question", "nit"];

export const severityLabels: Record<FindingSeverity, string> = { blocker: "Blocker", issue: "Issue", question: "Question", nit: "Nit" };

/** Lines of the reviewed (new) version of a file, counted from 1; a single line has endLine === line. */
export interface CodeAnchor {
  path: string;
  line: number;
  endLine: number;
}

/** Lines of the reviewed version around an anchor, so code outside the diff can be shown too. */
export interface CodeExcerpt {
  startLine: number;
  lines: string[];
}

export interface ReviewFlowStep {
  title: string;
  at: CodeAnchor;
  say: string;
  excerpt: CodeExcerpt;
}

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  checked: FindingCheck;
  at: CodeAnchor;
  title: string;
  /** Written as a comment to the change's author; this is what gets posted. */
  body: string;
  /** What the agent wrote, once the user reworded the body. */
  agentBody?: string;
  /** How the agent checked it, for the user only. */
  evidence?: string;
  excerpt: CodeExcerpt;
  decision: FindingDecision;
  /** Set once the finding is a comment on the pull request's pending review. */
  postedAs?: { threadId: string };
  postError?: string;
}

export interface ConversationComment {
  author: string;
  body: string;
  url: string;
  createdAt: string;
}

/** The agent's answer to a conversation (review thread) already on the pull request, shown with the conversation as GitHub had it. */
export interface ReviewAnswer {
  id: string;
  threadId: string;
  path: string;
  line: number | null;
  /** The lines it was about changed since. */
  outdated: boolean;
  resolved: boolean;
  /** Whether GitHub lets the user resolve it. */
  canResolve: boolean;
  comments: ConversationComment[];
  /** The reply as it gets posted in the conversation. */
  body: string;
  /** What the agent wrote, once the user reworded the body. */
  agentBody?: string;
  suggestsResolving: boolean;
  /** The user's go-ahead to resolve the conversation when the answer is posted. */
  resolve: boolean;
  decision: FindingDecision;
  /** Set once the answer is a reply on the pull request's pending review. */
  postedAs?: { url: string };
  postError?: string;
}

export type DiffRowKind = "context" | "added" | "removed";

export interface DiffRow {
  kind: DiffRowKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  newStart: number;
  rows: DiffRow[];
}

export type FileChange = "added" | "modified" | "deleted" | "renamed";

export interface ReviewFile {
  path: string;
  oldPath: string | null;
  change: FileChange;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** Why the file's diff is left out, e.g. a lock file; its counts still show. */
  hiddenBecause: string | null;
}

export interface PullRequestRef {
  url: string;
  host: string;
  owner: string;
  repo: string;
  number: number;
}

export interface Review {
  /** The root of the checkout the change was reviewed in. */
  repository: string;
  base: string;
  baseCommit: string;
  headCommit: string;
  pullRequest: PullRequestRef | null;
  verdict: string;
  summary: string;
  flow: ReviewFlowStep[];
  findings: ReviewFinding[];
  /** Missing on reviews published before answers existed; read it with answersOf. */
  answers?: ReviewAnswer[];
  files: ReviewFile[];
  posting: boolean;
  pendingReviewUrl: string | null;
  /** The agent's latest change to parts of the review in place: finding and answer ids, "summary", "verdict" or "flow". */
  agentEdit?: { at: number; parts: string[] };
  /** The highest finding number handed out so far, so a removed finding's id never names another one; missing until the agent changes the review. */
  lastFindingNumber?: number;
}

export const answersOf = (review: Review) => review.answers ?? [];

const ANCHOR = /^(.+):(\d+)(?:-(\d+))?$/;

export function parseAnchor(text: string): CodeAnchor | null {
  const match = ANCHOR.exec(text.trim());
  if (!match) return null;
  const line = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : line;
  return { path: match[1]!, line, endLine };
}

export const anchorLabel = ({ path, line, endLine }: CodeAnchor) => (endLine > line ? `${path}:${line}-${endLine}` : `${path}:${line}`);

const sideRows = (hunk: DiffHunk) => hunk.rows.filter((row) => row.newLine !== null);

/** GitHub takes comments only on lines of its diff's hunks, and a range only within one hunk. */
export function isCommentable(file: ReviewFile | undefined, { line, endLine }: CodeAnchor) {
  return (file?.hunks ?? []).some((hunk) => {
    const lines = sideRows(hunk).map((row) => row.newLine!);
    return lines.includes(line) && lines.includes(endLine);
  });
}

/** For each line of the new version, the removed lines that sat right before it. */
function removedBeforeLine(file: ReviewFile) {
  const removedBefore = new Map<number, DiffRow[]>();
  file.hunks.forEach((hunk) => {
    let removed: DiffRow[] = [];
    let lastNewLine = hunk.newStart - 1;
    hunk.rows.forEach((row) => {
      if (row.kind === "removed") return removed.push(row);
      lastNewLine = row.newLine!;
      if (removed.length > 0) removedBefore.set(row.newLine!, removed);
      removed = [];
    });
    if (removed.length > 0) removedBefore.set(Math.max(1, lastNewLine + 1), removed);
  });
  return removedBefore;
}

/** An excerpt of the new version with the change marked: added lines, and the removed lines where they were. */
export function excerptRows(file: ReviewFile | undefined, excerpt: CodeExcerpt): DiffRow[] {
  const added = new Set((file?.hunks ?? []).flatMap((hunk) => hunk.rows.filter((row) => row.kind === "added").map((row) => row.newLine!)));
  const removedBefore = file ? removedBeforeLine(file) : new Map<number, DiffRow[]>();
  const lineNumbers = excerpt.lines.map((_, index) => excerpt.startLine + index);
  return lineNumbers.flatMap((newLine, index): DiffRow[] => [
    ...(removedBefore.get(newLine) ?? []),
    { kind: added.has(newLine) ? "added" : "context", oldLine: null, newLine, text: excerpt.lines[index]! },
  ]);
}
