import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import type { CanvasItem } from "../shared/model.ts";
import {
  anchorLabel,
  answersOf,
  excerptRows,
  findingSeverities,
  isCommentable,
  severityLabels,
  type CodeAnchor,
  type DiffRow,
  type FindingDecision,
  type Review,
  type ReviewAnswer,
  type ReviewFile,
  type ReviewFinding,
} from "../shared/review.ts";
import { useEnterWhileBusy } from "./busy-sending.ts";
import { connection } from "./connection.ts";
import { highlightRows, type CodeSpan } from "./highlight.ts";
import { hints } from "./hints.ts";
import { MarkdownText } from "./Markdown.tsx";
import { CONTEXT_STEP, gapsOf, hiddenCount, nothingRevealed, revealedRows, type Gap, type Revealed } from "./review-context.ts";
import { isMac, keyLabels } from "./shortcuts.ts";
import { useTypingAidAttributes } from "./typing-aids.ts";
import { usePaneFullscreen } from "./Workspace.tsx";

export type ReviewItem = CanvasItem & { review: Review };

type Tab = "overview" | "flow" | "files" | "findings" | "conversations";

const tabs: { id: Tab; label: string; key: string }[] = [
  { id: "overview", label: "Overview", key: "1" },
  { id: "flow", label: "Flow", key: "2" },
  { id: "files", label: "Files", key: "3" },
  { id: "findings", label: "Findings", key: "4" },
  { id: "conversations", label: "Conversations", key: "5" },
];

const countOf = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "2 findings and 1 answer", leaving out what there is none of. */
const findingsAndAnswers = (findings: number, answers: number) =>
  [findings > 0 && countOf(findings, "finding"), answers > 0 && countOf(answers, "answer")].filter(Boolean).join(" and ");

const conversationPlace = ({ path, line }: ReviewAnswer) => (line === null ? path : `${path}:${line}`);

const MAX_TOPIC_LENGTH = 90;

/** The conversation's first comment, cut to a line, to name it in lists. */
function conversationTopic({ comments }: ReviewAnswer) {
  const firstLine = comments[0]?.body.split("\n").find((line) => line.trim())?.trim() ?? "";
  return firstLine.length > MAX_TOPIC_LENGTH ? `${firstLine.slice(0, MAX_TOPIC_LENGTH - 1)}…` : firstLine;
}

/** Lines picked in one block of code: rows `from` to `to` (in either order) of the block's rows. */
interface LineSelection {
  blockId: string;
  path: string;
  from: number;
  to: number;
  rows: DiffRow[];
}

const changeLetters: Record<ReviewFile["change"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

const fileOf = (review: Review, path: string) => review.files.find((file) => file.path === path);

const isWithin = (newLine: number | null, { line, endLine }: CodeAnchor) => newLine !== null && newLine >= line && newLine <= endLine;

const marker = (row: DiffRow) => (row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " ");

/** The files the tour walks through first, in its order, then the rest as git lists them. */
function filesInReadingOrder(review: Review) {
  const tourPaths = [...new Set(review.flow.map((step) => step.at.path))];
  const inTour = tourPaths.flatMap((path) => review.files.filter((file) => file.path === path));
  return [...inTour, ...review.files.filter((file) => !tourPaths.includes(file.path))];
}

function selectionLabel({ path, rows }: Pick<LineSelection, "path" | "rows">) {
  const newLines = rows.flatMap((row) => (row.newLine === null ? [] : [row.newLine]));
  if (newLines.length > 0) return anchorLabel({ path, line: Math.min(...newLines), endLine: Math.max(...newLines) });
  const oldLines = rows.flatMap((row) => (row.oldLine === null ? [] : [row.oldLine]));
  return `${path} (removed lines ${Math.min(...oldLines)}-${Math.max(...oldLines)})`;
}

const lineToOpen = (rows: DiffRow[]) => rows.find((row) => row.newLine !== null)?.newLine ?? rows[0]?.oldLine ?? 1;

/** A fence longer than any run of backticks in the code, so the code cannot close it. */
function fenced(code: string) {
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}diff\n${code}\n${fence}`;
}

const UPDATE_THE_REVIEW =
  "If your answer changes anything in the review (a finding, the tour, the summary or the verdict), change just those parts with the update_review tool; publish the whole review again only if the code under review changed.";

/** What a question is about: lines, and the finding they belong to when it was asked from one. */
type AskingAbout = Pick<LineSelection, "path" | "rows"> & { findingId?: string };

const quoted = (text: string) => text.split("\n").map((line) => `> ${line}`).join("\n");

/** A question from a finding names it and carries its comment as the user sees it, their own rewording included. */
function questionAbout(title: string, place: AskingAbout, finding: ReviewFinding | undefined, question: string, updatesReview: boolean) {
  const code = place.rows.map((row) => `${marker(row)}${row.text}`).join("\n");
  const subject = finding ? `${finding.id} ("${finding.title}") at ${selectionLabel(place)}` : selectionLabel(place);
  const comment = finding ? `\n\nIts comment now reads:\n\n${quoted(finding.body)}` : "";
  const asked = `About ${subject} in the review "${title}":${comment}\n\n${fenced(code)}\n\n${question.trim()}`;
  return updatesReview ? `${asked}\n\n${UPDATE_THE_REVIEW}` : asked;
}

const AGENT_EDIT_FLASH_MS = 2000;

/** Whether the agent changed this part of the review just now, while it was on screen, to draw the eye to it for a moment. */
function useAgentEdited(review: Review, part: string) {
  const at = review.agentEdit?.at;
  const seenAt = useRef(at);
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (at === seenAt.current) return;
    seenAt.current = at;
    const changed = Boolean(review.agentEdit?.parts.includes(part));
    setFlashing(changed);
    if (!changed) return;
    const timer = setTimeout(() => setFlashing(false), AGENT_EDIT_FLASH_MS);
    return () => clearTimeout(timer);
  }, [at]);
  return flashing;
}

function CodeText({ text, spans }: { text: string; spans: CodeSpan[] | undefined }) {
  if (!spans) return <code className="code-text">{text || " "}</code>;
  return (
    <code className="code-text">
      {spans.length === 0 ? " " : spans.map(({ text: piece, type }, index) => (type ? <span key={index} className={`token ${type}`}>{piece}</span> : piece))}
    </code>
  );
}

function openInEditor(itemId: string, path: string, line: number) {
  connection.send({ type: "review.open-in-editor", itemId, path, line });
}

function CodeBlock({
  blockId,
  path,
  rows,
  anchored,
  selection,
  onSelect,
  after,
}: {
  blockId: string;
  path: string;
  rows: DiffRow[];
  anchored?: CodeAnchor;
  selection: LineSelection | null;
  onSelect: (selection: LineSelection) => void;
  after?: (row: DiffRow) => ReactNode;
}) {
  const highlighted = useMemo(() => highlightRows(path, rows), [path, rows]);
  const ownSelection = selection?.blockId === blockId ? selection : null;
  const [first, last] = ownSelection ? [Math.min(ownSelection.from, ownSelection.to), Math.max(ownSelection.from, ownSelection.to)] : [-1, -1];
  const pick = (index: number, extend: boolean) => {
    const from = extend && ownSelection ? ownSelection.from : index;
    onSelect({ blockId, path, from, to: index, rows: rows.slice(Math.min(from, index), Math.max(from, index) + 1) });
  };
  return (
    <div className="code-block">
      {rows.map((row, index) => (
        <Fragment key={index}>
          <div
            className={["code-row", row.kind, anchored && isWithin(row.newLine, anchored) && "anchored", index >= first && index <= last && "selected"]
              .filter(Boolean)
              .join(" ")}
          >
            <button
              type="button"
              className="line-number"
              data-hint={hints.reviewLineNumber}
              aria-label={`Line ${row.newLine ?? row.oldLine}`}
              onClick={(event) => pick(index, event.shiftKey)}
            >
              {row.newLine ?? row.oldLine}
            </button>
            <span className="diff-marker">{marker(row)}</span>
            <CodeText text={row.text} spans={highlighted?.[index]} />
          </div>
          {after?.(row)}
        </Fragment>
      ))}
    </div>
  );
}

function FindingCard({
  item,
  finding,
  selected,
  showsCode,
  selection,
  onSelect,
  onGoToCode,
  onAsk,
}: {
  item: ReviewItem;
  finding: ReviewFinding;
  selected: boolean;
  showsCode: boolean;
  selection: LineSelection | null;
  onSelect: (selection: LineSelection) => void;
  onGoToCode?: () => void;
  onAsk: () => void;
}) {
  const { review } = item;
  const [editing, setEditing] = useState(false);
  const agentEdited = useAgentEdited(review, finding.id);
  const file = fileOf(review, finding.at.path);
  const update = (change: { decision?: FindingDecision; body?: string }) =>
    connection.send({ type: "review.update-finding", itemId: item.id, findingId: finding.id, ...change });
  const posted = Boolean(finding.postedAs);
  const save = (body: string) => {
    update({ body });
    setEditing(false);
  };
  return (
    <article
      className={["finding", `severity-${finding.severity}`, finding.decision === "drop" && "dropped", selected && "selected", agentEdited && "agent-edited"]
        .filter(Boolean)
        .join(" ")}
      data-finding-id={finding.id}
    >
      <header>
        <span className="severity">{severityLabels[finding.severity]}</span>
        <span className={`checked ${finding.checked}`} data-hint={hints.findingChecked}>
          {finding.checked === "confirmed" ? "✓ confirmed" : "? plausible"}
        </span>
        <span className="finding-title">{finding.title}</span>
        {onGoToCode ? (
          <button type="button" className="link anchor" onClick={onGoToCode}>
            {anchorLabel(finding.at)}
          </button>
        ) : (
          <span className="anchor">{anchorLabel(finding.at)}</span>
        )}
      </header>
      {editing ? <BodyEditor body={finding.body} onSave={save} onCancel={() => setEditing(false)} /> : <MarkdownText text={finding.body} />}
      {finding.evidence && (
        <details className="evidence">
          <summary>How it was checked</summary>
          <MarkdownText text={finding.evidence} />
        </details>
      )}
      {showsCode && (
        <CodeBlock
          blockId={`finding-${finding.id}`}
          path={finding.at.path}
          rows={excerptRows(file, finding.excerpt)}
          anchored={finding.at}
          selection={selection}
          onSelect={onSelect}
        />
      )}
      <footer>
        <FindingStatus review={review} finding={finding} file={file} />
        <span className="spacer" />
        <button
          type="button"
          className={`decision ${finding.decision}`}
          aria-pressed={finding.decision === "keep"}
          data-hint={hints.findingDecision}
          disabled={posted}
          onClick={() => update({ decision: finding.decision === "keep" ? "drop" : "keep" })}
        >
          {finding.decision === "keep" ? "Kept" : "Dropped"}
        </button>
        <button type="button" className="link" disabled={posted || editing} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" className="link" onClick={onAsk}>
          Ask
        </button>
        <button type="button" className="link" onClick={() => openInEditor(item.id, finding.at.path, finding.at.line)}>
          Open in IDEA
        </button>
      </footer>
    </article>
  );
}

/** Follows the agent's rewording until the user types; from then on their draft stays, with the agent's new wording shown under it. */
function BodyEditor({ body, onSave, onCancel }: { body: string; onSave: (body: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(body);
  const [startedFrom, setStartedFrom] = useState(body);
  const typingAidAttributes = useTypingAidAttributes();
  const startFrom = (text: string) => {
    setDraft(text);
    setStartedFrom(text);
  };
  const agentReworded = body !== startedFrom;
  if (agentReworded && draft === startedFrom) startFrom(body);
  return (
    <div className="finding-edit">
      <textarea {...typingAidAttributes} value={draft} rows={Math.max(3, draft.split("\n").length)} onChange={(event) => setDraft(event.target.value)} autoFocus />
      {agentReworded && (
        <div className="agent-reworded" role="status">
          <p>The agent reworded this while you were editing:</p>
          <MarkdownText text={body} />
          <button type="button" className="link" onClick={() => startFrom(body)}>
            Use its wording
          </button>
        </div>
      )}
      <div className="finding-edit-actions">
        <button type="button" className="primary" onClick={() => onSave(draft)} disabled={!draft.trim()}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function AnswerCard({ item, answer, selected }: { item: ReviewItem; answer: ReviewAnswer; selected: boolean }) {
  const [editing, setEditing] = useState(false);
  const agentEdited = useAgentEdited(item.review, answer.id);
  const update = (change: { decision?: FindingDecision; body?: string; resolve?: boolean }) =>
    connection.send({ type: "review.update-answer", itemId: item.id, answerId: answer.id, ...change });
  const posted = Boolean(answer.postedAs);
  const save = (body: string) => {
    update({ body });
    setEditing(false);
  };
  return (
    <article
      className={["finding", "answer", answer.decision === "drop" && "dropped", selected && "selected", agentEdited && "agent-edited"].filter(Boolean).join(" ")}
      data-answer-id={answer.id}
    >
      <header>
        <span className="anchor">{conversationPlace(answer)}</span>
        {answer.outdated && <span className="conversation-state">Outdated</span>}
        {answer.resolved && <span className="conversation-state resolved">Resolved</span>}
        {answer.comments[0] && (
          <a href={answer.comments[0].url} target="_blank" rel="noreferrer">
            View on GitHub
          </a>
        )}
      </header>
      <ol className="conversation-comments" aria-label="Conversation">
        {answer.comments.map((comment) => (
          <li key={comment.url}>
            <span className="comment-author">{comment.author}</span>
            <MarkdownText text={comment.body} />
          </li>
        ))}
      </ol>
      <div className="answer-body">
        <span className="comment-author">Answer</span>
        {editing ? <BodyEditor body={answer.body} onSave={save} onCancel={() => setEditing(false)} /> : <MarkdownText text={answer.body} />}
      </div>
      <footer>
        <AnswerStatus answer={answer} />
        {!answer.resolved && !posted && (
          <label className="resolve-choice" data-hint={answer.canResolve ? hints.answerResolve : hints.answerCannotResolve}>
            <input type="checkbox" checked={answer.resolve} disabled={!answer.canResolve} onChange={(event) => update({ resolve: event.target.checked })} />
            Resolve when posted{answer.suggestsResolving && " (the agent suggests it)"}
          </label>
        )}
        <button
          type="button"
          className={`decision ${answer.decision}`}
          aria-pressed={answer.decision === "keep"}
          data-hint={hints.answerDecision}
          disabled={posted}
          onClick={() => update({ decision: answer.decision === "keep" ? "drop" : "keep" })}
        >
          {answer.decision === "keep" ? "Kept" : "Dropped"}
        </button>
        <button type="button" className="link" disabled={posted || editing} onClick={() => setEditing(true)}>
          Edit
        </button>
      </footer>
    </article>
  );
}

function AnswerStatus({ answer }: { answer: ReviewAnswer }) {
  if (answer.postError) return <span className="finding-status failed">{answer.postedAs ? answer.postError : `GitHub refused it: ${answer.postError}`}</span>;
  if (answer.postedAs) return <span className="finding-status posted">On your pending review{answer.resolved && ", conversation resolved"}</span>;
  return null;
}

function FindingStatus({ review, finding, file }: { review: Review; finding: ReviewFinding; file: ReviewFile | undefined }) {
  if (finding.postedAs) return <span className="finding-status posted">On the pull request</span>;
  if (finding.postError) return <span className="finding-status failed">GitHub refused it: {finding.postError}</span>;
  if (review.pullRequest && !isCommentable(file, finding.at)) {
    return (
      <span className="finding-status outside" data-hint={hints.findingOutsideDiff}>
        Outside the pull request's diff
      </span>
    );
  }
  return null;
}

function PostPanel({ item }: { item: ReviewItem }) {
  const { review } = item;
  if (!review.pullRequest) return null;
  const kept = review.findings.filter((finding) => finding.decision === "keep" && !finding.postedAs);
  const toPost = kept.filter((finding) => isCommentable(fileOf(review, finding.at.path), finding.at));
  const posted = review.findings.filter((finding) => finding.postedAs).length;
  const outside = kept.length - toPost.length;
  const answers = answersOf(review);
  const answersToPost = answers.filter((answer) => answer.decision === "keep" && !answer.postedAs);
  const postedAnswers = answers.filter((answer) => answer.postedAs).length;
  const resolving = answersToPost.filter((answer) => answer.resolve && !answer.resolved).length;
  return (
    <section className="post-panel">
      <h3>
        Pull request{" "}
        <a href={review.pullRequest.url} target="_blank" rel="noreferrer">
          {review.pullRequest.owner}/{review.pullRequest.repo} pull {review.pullRequest.number}
        </a>
      </h3>
      <p>
        Kept findings go to the pull request as comments on a pending review{answers.length > 0 && ", and kept answers as replies in their conversations"},
        which only you see until you submit it on GitHub. Dropped ones stay here.
      </p>
      {outside > 0 && (
        <p className="hint">
          {outside === 1 ? "1 kept finding is" : `${outside} kept findings are`} on lines outside the pull request's diff; GitHub takes no
          line comments there.
        </p>
      )}
      {resolving > 0 && (
        <p className="hint">
          {resolving === 1 ? "1 conversation is" : `${resolving} conversations are`} resolved as you post, which everyone sees at once, before you submit the
          review.
        </p>
      )}
      {toPost.length + answersToPost.length > 0 || review.posting ? (
        <button type="button" className="primary" disabled={review.posting} onClick={() => connection.send({ type: "review.post", itemId: item.id })}>
          {review.posting ? "Posting…" : `Post ${findingsAndAnswers(toPost.length, answersToPost.length)} to the pull request`}
        </button>
      ) : (
        <p className="hint">Nothing new to post: no kept finding{answers.length > 0 && " or answer"} is waiting for it.</p>
      )}
      {review.pendingReviewUrl && (
        <p className="posted-note">
          {findingsAndAnswers(posted, postedAnswers) || "0 findings"} {posted + postedAnswers === 1 ? "is" : "are"} on your pending review.{" "}
          <a href={review.pendingReviewUrl} target="_blank" rel="noreferrer">
            Open it on GitHub
          </a>{" "}
          to read it over and submit it.
        </p>
      )}
    </section>
  );
}

function Overview({
  item,
  onStep,
  onFinding,
  onAnswer,
}: {
  item: ReviewItem;
  onStep: (index: number) => void;
  onFinding: (id: string) => void;
  onAnswer: (id: string) => void;
}) {
  const { review } = item;
  const answers = answersOf(review);
  const added = review.files.reduce((sum, file) => sum + file.added, 0);
  const removed = review.files.reduce((sum, file) => sum + file.removed, 0);
  const verdictEdited = useAgentEdited(review, "verdict");
  const summaryEdited = useAgentEdited(review, "summary");
  return (
    <div className="review-overview">
      <section className="overview-story">
        <p className={`verdict ${verdictEdited ? "agent-edited" : ""}`}>{review.verdict}</p>
        <p className="review-stats">
          {review.files.length} files changed · <span className="added-count">+{added}</span> <span className="removed-count">−{removed}</span> ·{" "}
          {review.base} ({review.baseCommit.slice(0, 8)}) → {review.headCommit.slice(0, 8)}
        </p>
        <div className={summaryEdited ? "agent-edited" : ""}>
          <MarkdownText text={review.summary} />
        </div>
        {review.flow.length > 0 && (
          <>
            <h3>How the code flows</h3>
            <ol className="overview-flow">
              {review.flow.map((step, index) => (
                <li key={index}>
                  <button type="button" className="link" onClick={() => onStep(index)}>
                    {step.title}
                  </button>{" "}
                  <span className="anchor">{anchorLabel(step.at)}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
      <section className="overview-findings">
        <h3>Findings</h3>
        {review.findings.length === 0 && <p className="hint">None.</p>}
        {findingSeverities.map((severity) => {
          const findings = review.findings.filter((finding) => finding.severity === severity);
          if (findings.length === 0) return null;
          return (
            <ul key={severity} className={`overview-finding-group severity-${severity}`}>
              {findings.map((finding) => (
                <li key={finding.id} className={finding.decision === "drop" ? "dropped" : ""}>
                  <span className="severity">{severityLabels[severity]}</span>
                  <button type="button" className="link" onClick={() => onFinding(finding.id)}>
                    {finding.title}
                  </button>
                  <span className="anchor">{anchorLabel(finding.at)}</span>
                </li>
              ))}
            </ul>
          );
        })}
        {answers.length > 0 && (
          <>
            <h3>Conversations answered</h3>
            <ul className="overview-finding-group">
              {answers.map((answer) => (
                <li key={answer.id} className={answer.decision === "drop" ? "dropped" : ""}>
                  <button type="button" className="link" onClick={() => onAnswer(answer.id)}>
                    {conversationTopic(answer)}
                  </button>
                  <span className="anchor">{conversationPlace(answer)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <PostPanel item={item} />
      </section>
    </div>
  );
}

function FlowTour({
  item,
  stepIndex,
  onStep,
  selection,
  onSelect,
  onGoToCode,
}: {
  item: ReviewItem;
  stepIndex: number;
  onStep: (index: number) => void;
  selection: LineSelection | null;
  onSelect: (selection: LineSelection) => void;
  onGoToCode: (anchor: CodeAnchor) => void;
}) {
  const { review } = item;
  const step = review.flow[stepIndex];
  const tourEdited = useAgentEdited(review, "flow");
  if (!step) return <p className="review-empty">The agent described no code flow.</p>;
  return (
    <div className={`review-split flow-tour ${tourEdited ? "agent-edited" : ""}`}>
      <nav className="review-list" aria-label="Flow steps">
        <ol>
          {review.flow.map((each, index) => (
            <li key={index}>
              <button type="button" className={index === stepIndex ? "selected" : ""} onClick={() => onStep(index)}>
                <span className="step-number">{index + 1}</span>
                <span className="step-title">{each.title}</span>
                <span className="anchor">{anchorLabel(each.at)}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <section className="review-main flow-step">
        <header className="flow-step-header">
          <span className="step-count">
            Step {stepIndex + 1} of {review.flow.length}
          </span>
          <h3>{step.title}</h3>
          <button type="button" className="link anchor" onClick={() => onGoToCode(step.at)}>
            {anchorLabel(step.at)}
          </button>
          <button type="button" className="link" onClick={() => openInEditor(item.id, step.at.path, step.at.line)}>
            Open in IDEA
          </button>
        </header>
        <div className="flow-step-say">
          <MarkdownText text={step.say} />
          <div className="flow-step-nav">
            <button type="button" disabled={stepIndex === 0} onClick={() => onStep(stepIndex - 1)}>
              ← Previous
            </button>
            <button type="button" disabled={stepIndex === review.flow.length - 1} onClick={() => onStep(stepIndex + 1)}>
              Next →
            </button>
          </div>
        </div>
        <CodeBlock
          blockId={`flow-${stepIndex}`}
          path={step.at.path}
          rows={excerptRows(fileOf(review, step.at.path), step.excerpt)}
          anchored={step.at}
          selection={selection}
          onSelect={onSelect}
        />
      </section>
    </div>
  );
}

function FileList({
  files,
  review,
  path,
  onPath,
  filterField,
}: {
  files: ReviewFile[];
  review: Review;
  path: string | null;
  onPath: (path: string) => void;
  filterField: RefObject<HTMLInputElement | null>;
}) {
  const [filter, setFilter] = useState("");
  const typingAidAttributes = useTypingAidAttributes();
  const tourPaths = new Set(review.flow.map((step) => step.at.path));
  const shown = files.filter((file) => file.path.toLowerCase().includes(filter.trim().toLowerCase()));
  const openFirstOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && shown[0]) onPath(shown[0].path);
    if (event.key === "Escape" && filter) {
      event.preventDefault();
      setFilter("");
    }
  };
  return (
    <nav className="review-list" aria-label="Changed files">
      <input
        {...typingAidAttributes}
        ref={filterField}
        className="file-filter"
        value={filter}
        placeholder="Filter files (f)"
        aria-label="Filter files"
        spellCheck={false}
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={openFirstOnEnter}
      />
      <ol>
        {shown.map((file) => {
          const findings = review.findings.filter((finding) => finding.at.path === file.path).length;
          const slash = file.path.lastIndexOf("/");
          return (
            <li key={file.path}>
              <button type="button" className={file.path === path ? "selected" : ""} title={file.path} onClick={() => onPath(file.path)}>
                <span className={`change change-${file.change}`}>{changeLetters[file.change]}</span>
                <span className="file-name">
                  <span className="file-directory">{file.path.slice(0, slash + 1)}</span>
                  {file.path.slice(slash + 1)}
                </span>
                {tourPaths.has(file.path) && (
                  <span className="in-tour" data-hint={hints.fileInTour}>
                    tour
                  </span>
                )}
                {findings > 0 && <span className="finding-count">{findings}</span>}
                <span className="added-count">+{file.added}</span>
                <span className="removed-count">−{file.removed}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export const reviewedFiles = new Map<string, Promise<string[]>>();

/** The reviewed version of a changed file, asked of the host once per review and file. */
export function reviewedFile(itemId: string, path: string) {
  const key = `${itemId}:${path}`;
  if (!reviewedFiles.has(key)) {
    const request = connection.sendAndAwait(
      (requestId) => ({ type: "review.read-file", requestId, itemId, path }),
      (message, requestId) => {
        if (message.type === "review.file-read" && message.requestId === requestId) return message.lines;
        if (message.type === "review.file-failed" && message.requestId === requestId) throw new Error(message.message);
        return undefined;
      },
    );
    request.catch(() => reviewedFiles.delete(key));
    reviewedFiles.set(key, request);
  }
  return reviewedFiles.get(key)!;
}

type RevealChange = (current: Revealed, hidden: number) => Revealed;

const revealUnderPrevious: RevealChange = ({ top, bottom }, hidden) => ({ top: top + Math.min(CONTEXT_STEP, hidden), bottom });
const revealOverNext: RevealChange = ({ top, bottom }, hidden) => ({ top, bottom: bottom + Math.min(CONTEXT_STEP, hidden) });
const revealAll: RevealChange = ({ top, bottom }, hidden) => ({ top: top + hidden, bottom });

const linesLabel = (count: number) => (count === 1 ? "1 line" : `${count} lines`);

/** The row between two hunks (or at the file's top or end) that shows more of the file around them; it carries the hunk's header. */
function GapRow({
  place,
  hidden,
  wasRevealed,
  header,
  error,
  onReveal,
}: {
  place: "top" | "between" | "end";
  hidden: number | null;
  wasRevealed: boolean;
  header: string | null;
  error: string | null;
  onReveal: (change: RevealChange) => void;
}) {
  const revealKeepingKeys = (change: RevealChange) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest<HTMLElement>(".review")?.focus({ preventScroll: true });
    onReveal(change);
  };
  if (hidden === 0 && (wasRevealed || !header)) return null;
  const fewLeft = hidden !== null && hidden <= CONTEXT_STEP;
  const down = place !== "top" && !fewLeft;
  const up = place !== "end" && !fewLeft;
  return (
    <div className="hunk-header">
      {hidden !== 0 && (
        <span className="gap-buttons">
          {down && (
            <button type="button" className="link" data-hint={hints.revealUnderPrevious} onClick={revealKeepingKeys(revealUnderPrevious)}>
              ↓ {CONTEXT_STEP} lines
            </button>
          )}
          {up && (
            <button type="button" className="link" data-hint={hints.revealOverNext} onClick={revealKeepingKeys(revealOverNext)}>
              ↑ {CONTEXT_STEP} lines
            </button>
          )}
          <button type="button" className="link" data-hint={hints.revealAll} onClick={revealKeepingKeys(revealAll)}>
            {hidden === null ? "Show the rest of the file" : fewLeft ? `Show ${linesLabel(hidden)}` : `All ${hidden} lines`}
          </button>
        </span>
      )}
      {header && <span className="hunk-header-text">{header}</span>}
      {error && <span className="gap-error">{error}</span>}
    </div>
  );
}

interface ShownContext {
  fileLines: string[];
  revealed: Revealed[];
}

/** What was shown around each file's hunks, so it is still shown after a look at another tab or file. */
export const shownContexts = new Map<string, ShownContext>();

/** Drops cached file lines and revealed hunks from previous review items. */
export function evictStaleReviewCaches(currentItemId: string) {
  for (const key of shownContexts.keys()) {
    if (!key.startsWith(`${currentItemId}:`)) shownContexts.delete(key);
  }
  for (const key of reviewedFiles.keys()) {
    if (!key.startsWith(`${currentItemId}:`)) reviewedFiles.delete(key);
  }
}

function useRevealedContext(itemId: string, file: ReviewFile) {
  const key = `${itemId}:${file.path}`;
  const gaps = useMemo(() => gapsOf(file), [file]);
  const [shown, setShown] = useState<ShownContext | null>(() => shownContexts.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const fileLines = shown?.fileLines ?? null;
  const revealed = shown?.revealed ?? gaps.map(() => nothingRevealed);

  const reveal = async (gapIndex: number, change: RevealChange) => {
    try {
      const lines = await reviewedFile(itemId, file.path);
      const next = {
        fileLines: lines,
        revealed: revealed.map((current, index) => (index === gapIndex ? change(current, hiddenCount(gaps[index]!, current, lines.length) ?? 0) : current)),
      };
      shownContexts.set(key, next);
      setShown(next);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const hunkRows = useMemo(
    () =>
      file.hunks.map((hunk, index) => {
        if (!fileLines) return hunk.rows;
        const over = revealedRows(gaps[index]!, revealed[index]!, fileLines).overNext;
        const under = revealedRows(gaps[index + 1]!, revealed[index + 1]!, fileLines).underPrevious;
        return over.length + under.length === 0 ? hunk.rows : [...over, ...hunk.rows, ...under];
      }),
    [file, shown],
  );

  const gapRow = (gapIndex: number, header: string | null) => {
    const gap: Gap | undefined = gaps[gapIndex];
    if (!gap) return null;
    const current = revealed[gapIndex]!;
    return (
      <GapRow
        place={gapIndex === 0 ? "top" : gapIndex === gaps.length - 1 ? "end" : "between"}
        hidden={hiddenCount(gap, current, fileLines?.length ?? null)}
        wasRevealed={current.top + current.bottom > 0}
        header={header}
        error={error}
        onReveal={(change) => void reveal(gapIndex, change)}
      />
    );
  };

  return { hunkRows, gapRow, lastGap: gaps.length - 1 };
}

function FileDiff({
  item,
  file,
  hunkIndex,
  findingId,
  selection,
  onSelect,
  onAsk,
}: {
  item: ReviewItem;
  file: ReviewFile;
  hunkIndex: number;
  findingId: string | null;
  selection: LineSelection | null;
  onSelect: (selection: LineSelection) => void;
  onAsk: (finding: ReviewFinding) => void;
}) {
  const { review } = item;
  const { hunkRows, gapRow, lastGap } = useRevealedContext(item.id, file);
  const findings = review.findings.filter((finding) => finding.at.path === file.path);
  const shownLines = new Set(hunkRows.flat().map((row) => row.newLine));
  const onDiff = findings.filter((finding) => shownLines.has(finding.at.endLine));
  const elsewhere = findings.filter((finding) => !onDiff.includes(finding));
  const steps = review.flow.map((step, index) => ({ step, index })).filter(({ step }) => step.at.path === file.path);
  const card = (finding: ReviewFinding) => (
    <FindingCard
      key={finding.id}
      item={item}
      finding={finding}
      selected={finding.id === findingId}
      showsCode={false}
      selection={selection}
      onSelect={onSelect}
      onAsk={() => onAsk(finding)}
    />
  );
  const afterRow = (row: DiffRow) => (
    <>
      {steps
        .filter(({ step }) => row.newLine === step.at.line)
        .map(({ step, index }) => (
          <div key={`step-${index}`} className="flow-marker">
            Flow step {index + 1}: {step.title}
          </div>
        ))}
      {onDiff.filter((finding) => row.newLine === finding.at.endLine).map(card)}
    </>
  );
  return (
    <section className="review-main file-diff">
      <header className="file-header">
        <span className={`change change-${file.change}`}>{changeLetters[file.change]}</span>
        <h3>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</h3>
        <span className="added-count">+{file.added}</span>
        <span className="removed-count">−{file.removed}</span>
        <span className="spacer" />
        {file.change !== "deleted" && (
          <button type="button" className="link" onClick={() => openInEditor(item.id, file.path, lineToOpen(file.hunks[hunkIndex]?.rows ?? []))}>
            Open in IDEA
          </button>
        )}
      </header>
      {elsewhere.length > 0 && (
        <div className="findings-elsewhere">
          <p className="hint">On lines this diff doesn't show:</p>
          {elsewhere.map(card)}
        </div>
      )}
      {file.hiddenBecause && <p className="review-empty">Not shown: {file.hiddenBecause}.</p>}
      {!file.hiddenBecause && file.hunks.length === 0 && <p className="review-empty">No changes to its lines{file.change === "renamed" ? "; only renamed" : ""}.</p>}
      {file.hunks.map((hunk, index) => (
        <div key={index} className={`hunk ${index === hunkIndex ? "current" : ""}`} data-hunk={index}>
          {gapRow(index, hunk.header || `line ${hunk.newStart}`)}
          <CodeBlock blockId={`file-${file.path}-${index}`} path={file.path} rows={hunkRows[index]!} selection={selection} onSelect={onSelect} after={afterRow} />
          {index === file.hunks.length - 1 && gapRow(lastGap, null)}
        </div>
      ))}
    </section>
  );
}

function AskAboutLines({ label, onSend, onClose }: { label: string; onSend: (question: string, updatesReview: boolean) => void; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const typingAidAttributes = useTypingAidAttributes();
  const { primary } = keyLabels();
  const sendOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (question.trim()) onSend(question, isMac ? event.metaKey : event.ctrlKey);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="ask-about-lines" role="dialog" aria-label="Ask the agent about these lines">
      <div className="ask-about-label">Ask the agent about {label}</div>
      <textarea
        {...typingAidAttributes}
        autoFocus
        value={question}
        rows={2}
        placeholder={`Your question (Enter asks, ${primary}Enter asks and updates the review, Shift+Enter for a new line, Esc cancels)`}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={sendOnEnter}
      />
      <div className="ask-about-actions">
        <button type="button" className="primary" disabled={!question.trim()} onClick={() => onSend(question, false)}>
          Ask
        </button>
        <button type="button" disabled={!question.trim()} onClick={() => onSend(question, true)} data-hint={hints.askAndUpdateReview}>
          Ask and update the review
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const isTextField = (target: EventTarget) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

function useScrollIntoView(root: RefObject<HTMLElement | null>, selector: string | null, when: unknown = selector) {
  useEffect(() => {
    if (selector) root.current?.querySelector(selector)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [when]);
}

/**
 * A review as a guided read: the agent's summary, a tour of the code flow, the diff with the findings on their lines,
 * and the findings to keep, drop, edit and post. Keys: 1-4 tabs, ←/→ tour steps, j/k changes, n/p findings,
 * f files, o open in IDEA, a ask the agent about the selected lines.
 */
export function ReviewView({ item, conversationId }: { item: ReviewItem; conversationId: string }) {
  const { review } = item;
  const root = useRef<HTMLDivElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  const files = useMemo(() => filesInReadingOrder(review), [review.files, review.flow]);
  const [tab, setTab] = useState<Tab>("overview");
  const [chosenStep, setStepIndex] = useState(0);
  const stepIndex = Math.min(chosenStep, Math.max(review.flow.length - 1, 0));
  const [path, setPath] = useState<string | null>(files[0]?.path ?? null);
  const [hunkIndex, setHunkIndex] = useState(0);
  const [findingId, setFindingId] = useState<string | null>(review.findings[0]?.id ?? null);
  const answers = answersOf(review);
  const [answerId, setAnswerId] = useState<string | null>(null);
  const shownTabs = tabs.filter(({ id }) => id !== "conversations" || answers.length > 0);
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [asking, setAsking] = useState<AskingAbout | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);
  const enterWhileBusy = useEnterWhileBusy();
  const fullscreen = usePaneFullscreen("canvas");
  const file = files.find((each) => each.path === path) ?? files[0];
  const finding = review.findings.find(({ id }) => id === findingId);

  useEffect(() => {
    evictStaleReviewCaches(item.id);
  }, [item.id]);

  useEffect(() => {
    const typingElsewhere = isTextField(document.activeElement ?? document.body) && !document.activeElement?.closest("[inert]");
    if (!typingElsewhere) root.current?.focus({ preventScroll: true });
  }, []);
  useScrollIntoView(root, tab === "files" ? `[data-hunk="${hunkIndex}"]` : null, `${tab} ${file?.path} ${hunkIndex}`);
  useScrollIntoView(root, findingId && (tab === "files" || tab === "findings") ? `[data-finding-id="${findingId}"]` : null);
  useScrollIntoView(root, answerId && tab === "conversations" ? `[data-answer-id="${answerId}"]` : null);

  const showFile = (nextPath: string, nextHunk = 0) => {
    setTab("files");
    setPath(nextPath);
    setHunkIndex(nextHunk);
  };
  const goToCode = (anchor: CodeAnchor) => {
    const target = fileOf(review, anchor.path);
    if (!target) return openInEditor(item.id, anchor.path, anchor.line);
    const hunk = target.hunks.findIndex((each) => each.rows.some((row) => isWithin(row.newLine, anchor)));
    showFile(anchor.path, Math.max(0, hunk));
  };
  const showFinding = (id: string, where: "files" | "findings") => {
    setFindingId(id);
    const target = review.findings.find((each) => each.id === id);
    if (where === "files" && target && fileOf(review, target.at.path)) goToCode(target.at);
    else setTab("findings");
  };
  const stepFinding = (step: 1 | -1) => {
    if (review.findings.length === 0) return;
    const index = review.findings.findIndex(({ id }) => id === findingId);
    const next = review.findings[(index + step + review.findings.length) % review.findings.length]!;
    showFinding(next.id, tab === "files" ? "files" : "findings");
  };
  const stepHunk = (step: 1 | -1) => {
    const fileIndex = files.findIndex((each) => each.path === file?.path);
    const nextHunk = hunkIndex + step;
    if (file && nextHunk >= 0 && nextHunk < file.hunks.length) return setHunkIndex(nextHunk);
    const following = step === 1 ? files.slice(fileIndex + 1) : files.slice(0, Math.max(0, fileIndex)).reverse();
    const nextFile = following.find((each) => each.hunks.length > 0);
    if (nextFile) showFile(nextFile.path, step === 1 ? 0 : nextFile.hunks.length - 1);
  };
  const stepTour = (step: 1 | -1) => setStepIndex((index) => Math.min(Math.max(index + step, 0), Math.max(review.flow.length - 1, 0)));

  const currentPlace = (): AskingAbout | null => {
    if (selection) return selection;
    if (tab === "flow" && review.flow[stepIndex]) {
      const step = review.flow[stepIndex]!;
      return { path: step.at.path, rows: excerptRows(fileOf(review, step.at.path), step.excerpt).filter((row) => isWithin(row.newLine, step.at)) };
    }
    if (tab === "files" && file?.hunks[hunkIndex]) return { path: file.path, rows: file.hunks[hunkIndex]!.rows };
    if (tab === "findings" && finding) return placeOfFinding(finding);
    return null;
  };
  const placeOfFinding = (target: ReviewFinding): AskingAbout => ({
    findingId: target.id,
    path: target.at.path,
    rows: excerptRows(fileOf(review, target.at.path), target.excerpt).filter((row) => isWithin(row.newLine, target.at)),
  });
  const askingLabel = (place: AskingAbout) => {
    const askedFinding = review.findings.find(({ id }) => id === place.findingId);
    return askedFinding ? `the finding "${askedFinding.title}" at ${selectionLabel(place)}` : selectionLabel(place);
  };
  const askAboutCurrentPlace = () => {
    const place = currentPlace();
    if (place && place.rows.length > 0) setAsking(place);
  };
  const openCurrentPlace = () => {
    const place = currentPlace();
    if (place) openInEditor(item.id, place.path, lineToOpen(place.rows));
  };
  const send = (question: string, updatesReview: boolean) => {
    if (!asking) return;
    const askedFinding = review.findings.find(({ id }) => id === asking.findingId);
    const text = questionAbout(item.title, asking, askedFinding, question, updatesReview);
    if (!connection.send({ type: "conversation.prompt", conversationId, text, imageIds: [], afterTurn: enterWhileBusy === "after-turn" })) return;
    const updating = updatesReview ? ", and the agent updates the parts of the review it changes" : "";
    setSentNote(`Asked about ${askingLabel(asking)}. The answer comes in the chat${updating}.`);
    setAsking(null);
    setSelection(null);
    root.current?.focus();
  };

  const keyActions: Record<string, () => void> = {
    ArrowLeft: () => tab === "flow" && stepTour(-1),
    ArrowRight: () => tab === "flow" && stepTour(1),
    j: () => (tab === "findings" ? stepFinding(1) : stepHunk(1)),
    k: () => (tab === "findings" ? stepFinding(-1) : stepHunk(-1)),
    n: () => stepFinding(1),
    p: () => stepFinding(-1),
    f: () => {
      setTab("files");
      requestAnimationFrame(() => filterField.current?.focus());
    },
    o: openCurrentPlace,
    a: askAboutCurrentPlace,
    ...Object.fromEntries(shownTabs.map(({ id, key }) => [key, () => setTab(id)])),
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTextField(event.target)) return;
    if (event.key === "Escape" && (selection || sentNote)) {
      event.preventDefault();
      setSelection(null);
      setSentNote(null);
      return;
    }
    const action = keyActions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };
  const select = (next: LineSelection) => {
    setSelection(next);
    setSentNote(null);
  };

  return (
    <div className="review" ref={root} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="review-bar">
        <div className="review-tabs" role="tablist" aria-label="Review">
          {shownTabs.map(({ id, label, key }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "selected" : ""} data-shortcut={key} onClick={() => setTab(id)}>
              {label}
              {id === "flow" && <span className="tab-count">{review.flow.length}</span>}
              {id === "files" && <span className="tab-count">{review.files.length}</span>}
              {id === "findings" && <span className="tab-count">{review.findings.filter((each) => each.decision === "keep").length}</span>}
              {id === "conversations" && <span className="tab-count">{answers.filter((each) => each.decision === "keep").length}</span>}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {selection && (
          <span className="selection-actions">
            <span className="selection-label">{selectionLabel(selection)}</span>
            <button type="button" onClick={() => setAsking(selection)}>
              Ask (a)
            </button>
            <button type="button" onClick={() => openInEditor(item.id, selection.path, lineToOpen(selection.rows))}>
              Open in IDEA (o)
            </button>
          </span>
        )}
        {fullscreen && (
          <button type="button" className="placement-toggle" data-hint={hints.reviewPlacement} onClick={() => fullscreen.setFullscreen(!fullscreen.isFullscreen)}>
            {fullscreen.isFullscreen ? "Beside the chat" : "Full screen"}
          </button>
        )}
      </div>
      <div className="review-body">
        {tab === "overview" && (
          <Overview
            item={item}
            onStep={(index) => {
              setStepIndex(index);
              setTab("flow");
            }}
            onFinding={(id) => showFinding(id, "findings")}
            onAnswer={(id) => {
              setAnswerId(id);
              setTab("conversations");
            }}
          />
        )}
        {tab === "flow" && <FlowTour item={item} stepIndex={stepIndex} onStep={setStepIndex} selection={selection} onSelect={select} onGoToCode={goToCode} />}
        {tab === "files" && (
          <div className="review-split files-view">
            <FileList files={files} review={review} path={file?.path ?? null} onPath={(next) => showFile(next)} filterField={filterField} />
            {file ? (
              <FileDiff
                key={file.path}
                item={item}
                file={file}
                hunkIndex={hunkIndex}
                findingId={findingId}
                selection={selection}
                onSelect={select}
                onAsk={(target) => setAsking(placeOfFinding(target))}
              />
            ) : (
              <p className="review-empty">No files changed.</p>
            )}
          </div>
        )}
        {tab === "findings" && (
          <div className="findings-view">
            {review.findings.length === 0 && <p className="review-empty">The agent found nothing to comment on.</p>}
            {review.findings.map((each) => (
              <FindingCard
                key={each.id}
                item={item}
                finding={each}
                selected={each.id === findingId}
                showsCode
                selection={selection}
                onSelect={select}
                onGoToCode={() => goToCode(each.at)}
                onAsk={() => setAsking(placeOfFinding(each))}
              />
            ))}
            <PostPanel item={item} />
          </div>
        )}
        {tab === "conversations" && (
          <div className="findings-view">
            {answers.map((each) => (
              <AnswerCard key={each.id} item={item} answer={each} selected={each.id === answerId} />
            ))}
            <PostPanel item={item} />
          </div>
        )}
      </div>
      {asking && (
        <AskAboutLines
          label={askingLabel(asking)}
          onSend={send}
          onClose={() => {
            setAsking(null);
            root.current?.focus();
          }}
        />
      )}
      {sentNote && (
        <div className="review-sent" role="status">
          {sentNote}
          {fullscreen?.isFullscreen && (
            <button type="button" className="link" onClick={() => fullscreen.setFullscreen(false)}>
              Show the chat
            </button>
          )}
        </div>
      )}
      <footer className="review-keys" aria-hidden="true">
        <kbd>1</kbd>–<kbd>{shownTabs.length}</kbd> tabs · <kbd>←</kbd>/<kbd>→</kbd> tour · <kbd>j</kbd>/<kbd>k</kbd> changes · <kbd>n</kbd>/<kbd>p</kbd> findings ·{" "}
        <kbd>f</kbd> files · click line numbers (⇧ to extend), then <kbd>a</kbd> ask or <kbd>o</kbd> open in IDEA
      </footer>
    </div>
  );
}
