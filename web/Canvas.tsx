import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { buildCanvasDocument, canvasThemeMessage, isCanvasFrameMessage } from "../shared/canvas-document.ts";
import { answersSummary, questionsOf } from "../shared/ask.ts";
import type { AskQuestion, CanvasItem } from "../shared/model.ts";
import { connection } from "./connection.ts";
import { settledEditNote, type EditRequest } from "./edit-approval.ts";
import { ChangesView } from "./Changes.tsx";
import { EditApproval } from "./EditApproval.tsx";
import { hints } from "./hints.ts";
import { SettledNoteLine, type SettledNote } from "./SettledNote.tsx";
import { shortcutKeys } from "./shortcuts.ts";
import { onShownThemeChange, shownTheme } from "./theme.ts";
import { formatClockTime, formatFullTime } from "./timestamps.ts";
import { useTypingAidAttributes } from "./typing-aids.ts";
import { WalkthroughView, type ReviewItem, type TourItem } from "./Review.tsx";
import { currentReviewPlacement, takeArrivedReview } from "./review-placement.ts";
import { FullscreenToggle, PaneGrip, usePaneFullscreen } from "./Workspace.tsx";

/** Content as wide as the viewport would otherwise widen the frame that measures it without end. */
const MAX_CONTENT_WIDTH = 2400;

interface ContentSize {
  height: number;
  /** The width the content asked for when it overflowed; kept once known, as the frame drawn that wide reports no overflow. */
  width: number | null;
}

function useElementWidth(element: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new ResizeObserver(() => setWidth(target.clientWidth));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return width;
}

/** The fitted frames (a question's page and its option previews) have a 1px border. */
const FRAME_BORDERS = 2;

/** A wheel turn reported by a page that could not use it: the panel holding the page scrolls by it instead. */
function scrollPanelBy(frame: HTMLIFrameElement | null, wheel: { deltaY: number; deltaMode: number }) {
  const panel = scrollableAncestor(frame);
  if (!panel) return;
  const lines = wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? panel.clientHeight : 1;
  panel.scrollBy({ top: wheel.deltaY * lines });
}

function scrollableAncestor(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** Sized to its content; content wider than the room is drawn at its own width and scaled down to fit, so none of it is cut off. */
function fittedStyles(contentSize: ContentSize | undefined, roomWidth: number): { box?: CSSProperties; frame?: CSSProperties } {
  if (!contentSize) return {};
  const { width, height } = contentSize;
  if (!width || !roomWidth || width + FRAME_BORDERS <= roomWidth) return { frame: { height } };
  const scale = roomWidth / (width + FRAME_BORDERS);
  return {
    box: { height: Math.ceil((height + FRAME_BORDERS) * scale) },
    frame: { position: "absolute", width, height, transform: `scale(${scale})`, transformOrigin: "0 0" },
  };
}

function CanvasFrame({
  frameId,
  html,
  assetsOrigin,
  className,
  fitsContent = false,
  onRendered,
  onContentWidth,
}: {
  frameId: string;
  html: string;
  assetsOrigin: string;
  className?: string;
  fitsContent?: boolean;
  onRendered?: (errors: string[]) => void;
  onContentWidth?: (width: number) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const roomWidth = useElementWidth(box);
  const [errors, setErrors] = useState<string[]>([]);
  const [contentSize, setContentSize] = useState<ContentSize>();
  // The theme is not a dependency: changing it would reload the page, so it reaches a shown page by message instead.
  const document = useMemo(() => buildCanvasDocument(html, frameId, assetsOrigin, shownTheme()), [html, frameId, assetsOrigin]);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  const onContentWidthRef = useRef(onContentWidth);
  onContentWidthRef.current = onContentWidth;

  useEffect(() => {
    setErrors([]);
    setContentSize(undefined);
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !isCanvasFrameMessage(event.data)) return;
      const message = event.data;
      if (message.kind === "error") setErrors((current) => [...current, message.message]);
      if (message.kind === "rendered") onRenderedRef.current?.(message.errors);
      if (message.kind === "size") {
        const askedWidth = message.overflowWidth && Math.min(message.overflowWidth, MAX_CONTENT_WIDTH);
        setContentSize((current) => ({ height: message.height, width: askedWidth || current?.width || null }));
      }
      if (message.kind === "wheel") scrollPanelBy(frame.current, message);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [document]);

  useEffect(() => {
    if (contentSize?.width) onContentWidthRef.current?.(contentSize.width);
  }, [contentSize?.width]);

  useEffect(() => onShownThemeChange(() => postThemeTo(frame)), []);

  const fitted = fitsContent ? fittedStyles(contentSize, roomWidth) : {};
  return (
    <div ref={box} className={`canvas-frame ${className ?? ""}`} style={fitted.box}>
      <iframe ref={frame} sandbox="allow-scripts" srcDoc={document} title={frameId} style={fitted.frame} onLoad={() => postThemeTo(frame)} />
      {errors.length > 0 && (
        <ul className="frame-errors">
          {errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Also on load: a theme chosen while the page was still opening went to the frame's blank window and was lost. */
function postThemeTo(frame: RefObject<HTMLIFrameElement | null>) {
  frame.current?.contentWindow?.postMessage(canvasThemeMessage(shownTheme()), "*");
}

function reportRender(itemId: string) {
  return (errors: string[]) => connection.send({ type: "canvas.report", itemId, errors });
}

const SOMETHING_ELSE = Symbol("something else");

interface AskDraft {
  choice: string | typeof SOMETHING_ELSE | null;
  other: string;
  note: string;
}

const emptyDraft = (): AskDraft => ({ choice: null, other: "", note: "" });
const draftAnswer = ({ choice, other }: AskDraft) => (choice === SOMETHING_ELSE ? other.trim() : choice) || null;

interface AskProgress {
  drafts: AskDraft[];
  page: number;
}

/** What the user has answered so far and which question they are on, kept for as long as the page lives, so leaving the conversation and coming back loses nothing. */
const askProgressByItem = new Map<string, AskProgress>();

function useAskProgress(itemId: string, questionCount: number) {
  const [progress, setProgress] = useState<AskProgress>(() => askProgressByItem.get(itemId) ?? { drafts: Array.from({ length: questionCount }, emptyDraft), page: 0 });
  useEffect(() => {
    askProgressByItem.set(itemId, progress);
  }, [itemId, progress]);
  return {
    drafts: progress.drafts,
    page: progress.page,
    setPage: (page: number) => setProgress((current) => ({ ...current, page })),
    changeDraft: (index: number, change: Partial<AskDraft>) =>
      setProgress((current) => ({ ...current, drafts: current.drafts.map((draft, at) => (at === index ? { ...draft, ...change } : draft)) })),
  };
}

function AskQuestionFields({
  question,
  draft,
  onChange,
  waiting,
  chosenLabel,
  idPrefix,
  radioName,
  assetsOrigin,
}: {
  question: AskQuestion;
  draft: AskDraft;
  onChange: (change: Partial<AskDraft>) => void;
  waiting: boolean;
  chosenLabel: string | undefined;
  idPrefix: string;
  radioName: string;
  assetsOrigin: string;
}) {
  const typingAidAttributes = useTypingAidAttributes();
  const [previewWidths, setPreviewWidths] = useState<Record<string, number>>({});
  const widestPreview = Math.max(0, ...Object.values(previewWidths));
  const optionsStyle = {
    ...(widestPreview > 0 && { "--preview-width": `${widestPreview}px` }),
    ...(question.optionWidth && { "--option-width": `${question.optionWidth}px` }),
  } as CSSProperties;
  const isChosen = (label: string) => (waiting ? draft.choice === label : chosenLabel === label);

  return (
    <>
      {question.html && <CanvasFrame frameId={`${idPrefix}-context`} html={question.html} assetsOrigin={assetsOrigin} className="ask-context" fitsContent />}
      <div className="ask-options" role="radiogroup" aria-label={question.question} style={optionsStyle}>
        {question.options.map((option, index) => (
          <label key={option.label} className={`ask-option ${isChosen(option.label) ? "chosen" : ""}`}>
            <span className="ask-option-head">
              <input
                type="radio"
                name={radioName}
                aria-label={option.label}
                checked={isChosen(option.label)}
                disabled={!waiting}
                onChange={() => onChange({ choice: option.label })}
              />
              <span className="ask-option-label">{option.label}</span>
            </span>
            {option.description && <span className="ask-option-description">{option.description}</span>}
            {option.html && (
              <CanvasFrame
                frameId={`${idPrefix}-option-${index}`}
                html={option.html}
                assetsOrigin={assetsOrigin}
                className="ask-preview"
                fitsContent
                onContentWidth={(width) => setPreviewWidths((current) => ({ ...current, [option.label]: width }))}
              />
            )}
          </label>
        ))}
      </div>
      {waiting && (
        <div className="ask-extras">
          {question.allowOther && (
            <label className={`ask-other ${draft.choice === SOMETHING_ELSE ? "chosen" : ""}`}>
              <input type="radio" name={radioName} aria-label="Something else" checked={draft.choice === SOMETHING_ELSE} onChange={() => onChange({ choice: SOMETHING_ELSE })} />
              <textarea
                {...typingAidAttributes}
                rows={Math.min(6, draft.other.split("\n").length)}
                value={draft.other}
                placeholder="Something else…"
                aria-label="Your own answer"
                onFocus={() => onChange({ choice: SOMETHING_ELSE })}
                onChange={(event) => onChange({ other: event.target.value })}
                onKeyDown={answerOnEnter}
              />
            </label>
          )}
          <textarea
            {...typingAidAttributes}
            value={draft.note}
            placeholder="Optional note for the agent (sent with your answer)"
            onChange={(event) => onChange({ note: event.target.value })}
          />
        </div>
      )}
    </>
  );
}

/** As in the message box: Enter answers, Shift+Enter starts a new line. */
function answerOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

const deliveredNote = (answer: NonNullable<CanvasItem["answer"]>) => (answer.deliveredAs === "tool-result" ? " (returned to the agent)" : " (sent as your next message)");

function AnsweredSeveral({ answer }: { answer: NonNullable<CanvasItem["answer"]> }) {
  return (
    <div className="ask-answer">
      You answered:
      <ol className="ask-review">
        {(answer.answers ?? []).map((entry, index) => (
          <li key={index}>
            {entry.question} <strong>{entry.label}</strong>
            {entry.note && <> — “{entry.note}”</>}
          </li>
        ))}
      </ol>
      <span className="delivered">{deliveredNote(answer)}</span>
    </div>
  );
}

function AskView({ item, pagesBefore, assetsOrigin }: { item: CanvasItem; pagesBefore: CanvasItem[]; assetsOrigin: string }) {
  const questions = questionsOf(item);
  const several = item.questions !== undefined;
  const waiting = item.status === "waiting";
  const { drafts, page, setPage, changeDraft } = useAskProgress(item.id, questions.length);
  const answers = drafts.map(draftAnswer);
  const onReviewPage = several && waiting && page >= questions.length;
  const shownQuestion = questions[Math.min(page, questions.length - 1)];
  const questionIndex = several ? Math.min(page, questions.length - 1) : 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (several) {
      if (!onReviewPage) {
        if (answers[questionIndex]) setPage(page + 1);
        return;
      }
      if (answers.some((answer) => !answer)) return;
      const entries = drafts.map((draft) => ({ label: draftAnswer(draft)!, note: draft.note.trim() || undefined }));
      connection.send({ type: "ask.answer", itemId: item.id, label: answersSummary(entries), answers: entries });
      return;
    }
    const [answer] = answers;
    if (answer) connection.send({ type: "ask.answer", itemId: item.id, label: answer, note: drafts[0]!.note.trim() || undefined });
  };

  if (!shownQuestion) return null;
  const pagesBeforeShown = !several || page === 0 ? pagesBefore : [];
  const currentAnswer = answers[questionIndex];

  return (
    <form className="ask" onSubmit={submit}>
      {several && waiting && !onReviewPage && <p className="ask-progress">{`Question ${page + 1} of ${questions.length}`}</p>}
      {several && waiting && onReviewPage && <p className="ask-progress">Review your answers</p>}
      <h3>{several ? (waiting ? (onReviewPage ? "Is this right?" : shownQuestion.question) : item.title) : item.question}</h3>
      {item.status === "answered" && item.answer && !several && (
        <div className="ask-answer">
          You chose <strong>{item.answer.label}</strong>
          {item.answer.note && <> — “{item.answer.note}”</>}
          <span className="delivered">{deliveredNote(item.answer)}</span>
        </div>
      )}
      {item.status === "answered" && item.answer && several && <AnsweredSeveral answer={item.answer} />}
      {item.status === "cancelled" && <div className="ask-answer">This question was withdrawn.</div>}
      {pagesBeforeShown.map((before) => (
        <section key={before.id} className="ask-page-before" aria-label={`Shown before the question: ${before.title}`}>
          <div className="ask-page-before-title" data-hint={hints.askPageBefore}>
            Shown just before: {before.title}
          </div>
          <CanvasFrame frameId={`${item.id}-before-${before.id}`} html={before.html ?? ""} assetsOrigin={assetsOrigin} className="ask-context" fitsContent />
        </section>
      ))}
      {onReviewPage && (
        <ol className="ask-review">
          {questions.map((question, index) => (
            <li key={index}>
              {question.question} <strong>{answers[index]}</strong>
              {drafts[index]!.note.trim() && <> — “{drafts[index]!.note.trim()}”</>}{" "}
              <button type="button" className="link" onClick={() => setPage(index)}>
                Change
              </button>
            </li>
          ))}
        </ol>
      )}
      {!onReviewPage && (!several || waiting) && (
        <AskQuestionFields
          key={questionIndex}
          question={shownQuestion}
          draft={drafts[questionIndex]!}
          onChange={(change) => changeDraft(questionIndex, change)}
          waiting={waiting}
          chosenLabel={item.answer?.label}
          idPrefix={several ? `${item.id}-${questionIndex}` : item.id}
          radioName={several ? `ask-${item.id}-${questionIndex}` : `ask-${item.id}`}
          assetsOrigin={assetsOrigin}
        />
      )}
      {waiting && !several && (
        <div className="ask-submit">
          <span className="ask-selection">{currentAnswer ? <>Your answer: <strong>{currentAnswer}</strong></> : "Pick an option to answer"}</span>
          <button type="submit" className="primary" disabled={!currentAnswer}>
            Submit
          </button>
        </div>
      )}
      {waiting && several && (
        <div className="ask-submit">
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Back
          </button>
          <span className="ask-selection">{onReviewPage ? "" : currentAnswer ? <>Your answer: <strong>{currentAnswer}</strong></> : "Pick an option to answer"}</span>
          {onReviewPage ? (
            <button key="submit" type="submit" className="primary" disabled={answers.some((answer) => !answer)}>
              Submit
            </button>
          ) : (
            <button key="next" type="button" className="primary" disabled={!currentAnswer} onClick={() => setPage(page + 1)}>
              Next
            </button>
          )}
        </div>
      )}
    </form>
  );
}

const kindIcons: Record<CanvasItem["kind"], string> = { show: "▣", ask: "?", review: "⇄", tour: "↯" };

function outcomeOf(item: CanvasItem) {
  if (item.review) return item.review.verdict;
  if (item.status === "waiting") return "needs your answer";
  if (item.status === "cancelled") return "withdrawn";
  if (item.status === "answered" && item.answer) return `→ ${item.answer.label}`;
  return "";
}

/** Once a question is answered or withdrawn, it has had its turn on the canvas. */
const isSettledQuestion = (item: CanvasItem) => item.kind === "ask" && item.status !== "waiting";

function settledMessage(item: CanvasItem): SettledNote {
  return item.status === "answered" ? { text: `✓ Answer sent: “${item.answer?.label ?? ""}”`, tone: "done" } : { text: "The agent withdrew its question.", tone: "neutral" };
}

/** A note that goes away by itself a few seconds after it is set. */
function useFadingNote() {
  const [note, setNote] = useState<SettledNote | null>(null);
  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(timer);
  }, [note]);
  return [note, setNote] as const;
}

/** Clears the canvas when the question on it gets settled, leaving a short note of what happened. */
function useClearWhenSettled(selected: CanvasItem | undefined, clear: () => void) {
  const [note, setNote] = useFadingNote();
  const previous = useRef<{ id: string; status: CanvasItem["status"] } | null>(null);
  useEffect(() => {
    const wasWaiting = previous.current?.id === selected?.id && previous.current?.status === "waiting";
    previous.current = selected ? { id: selected.id, status: selected.status } : null;
    if (selected && wasWaiting && isSettledQuestion(selected)) {
      setNote(settledMessage(selected));
      clear();
    }
  }, [selected?.id, selected?.status]);
  return note;
}

/**
 * The oldest edit the agent waits for permission to make takes the canvas, unless the user set the edits aside to look
 * at something else; a new one takes it back. Once the edit on the canvas is answered, the canvas clears and notes the answer.
 */
function useEditsOnCanvas(edits: EditRequest[], clear: () => void) {
  const waiting = edits.filter((edit) => !edit.resolved);
  const [setAside, setSetAside] = useState(false);
  const [note, setNote] = useFadingNote();
  const shown = setAside ? undefined : waiting[0];
  const previouslyShown = useRef<string | null>(null);
  const oldestWaiting = waiting[0]?.permissionId;
  useEffect(() => {
    if (oldestWaiting) setSetAside(false);
  }, [oldestWaiting]);
  useEffect(() => {
    const before = previouslyShown.current;
    previouslyShown.current = shown?.permissionId ?? null;
    const answered = before === shown?.permissionId ? undefined : edits.find((edit) => edit.permissionId === before && edit.resolved);
    if (!answered) return;
    setNote(settledEditNote(answered));
    clear();
  }, [shown?.permissionId, edits]);
  return { shown, waiting: waiting.length, note, setAside: () => setSetAside(true), bringBack: () => setSetAside(false) };
}

function CanvasHistory({ items, selectedId, onPick }: { items: CanvasItem[]; selectedId: string | null; onPick: (id: string) => void }) {
  return (
    <ul className="canvas-history" aria-label="Canvas history">
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" className={`history-entry ${item.id === selectedId ? "selected" : ""} status-${item.status}`} onClick={() => onPick(item.id)}>
            <time className="timestamp" title={formatFullTime(item.createdAt)}>
              {formatClockTime(item.createdAt)}
            </time>
            <span className="entry-kind">{kindIcons[item.kind]}</span>
            <span className="entry-title">{item.title}</span>
            <span className="entry-outcome">{outcomeOf(item)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Opens a review full screen or beside the chat, as Settings say; moving on from it gives back the layout it took. */
function useReviewPlacement() {
  const fullscreen = usePaneFullscreen("canvas");
  const tookFullscreen = useRef(false);
  return (item: CanvasItem | undefined) => {
    if (!fullscreen) return;
    if (item?.kind === "review") {
      const wanted = currentReviewPlacement() === "fullscreen";
      fullscreen.setFullscreen(wanted);
      tookFullscreen.current = wanted;
    } else if (tookFullscreen.current) {
      fullscreen.setFullscreen(false);
      tookFullscreen.current = false;
    }
  };
}

/** What each conversation's canvas showed when the user left it, which the panel, made again for each conversation, picks up. */
const leftViews = new Map<string, { newestId: string | undefined; selectedId: string | null; changesOpen: boolean }>();

export function CanvasPanel({
  conversationId,
  items,
  edits,
  assetsOrigin,
  changesRefreshPoint,
  onHide,
}: {
  conversationId: string;
  items: CanvasItem[];
  /** The edits the agent asked permission for; none when Settings keep them in the chat. */
  edits: EditRequest[];
  assetsOrigin: string;
  changesRefreshPoint: number;
  onHide: () => void;
}) {
  const newestFirst = useMemo(() => [...items].sort((a, b) => b.createdAt - a.createdAt), [items]);
  const newest = newestFirst[0];
  const onCanvasByDefault = newest && !isSettledQuestion(newest) ? newest.id : null;
  const left = leftViews.get(conversationId);
  const nothingNewSinceLeft = left?.newestId === newest?.id;
  const [selectedId, setSelectedId] = useState<string | null>(left && nothingNewSinceLeft ? left.selectedId : onCanvasByDefault);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(Boolean(left?.changesOpen && nothingNewSinceLeft));
  const placeForReview = useReviewPlacement();
  const keptSinceLeft = useRef(nothingNewSinceLeft);
  useEffect(() => {
    if (!keptSinceLeft.current) {
      setSelectedId(onCanvasByDefault);
      setChangesOpen(false);
    }
    keptSinceLeft.current = false;
    if (takeArrivedReview(newest)) placeForReview(newest);
  }, [newest?.id]);
  useEffect(() => {
    leftViews.set(conversationId, { newestId: newest?.id, selectedId, changesOpen });
  }, [conversationId, newest?.id, selectedId, changesOpen]);
  const edit = useEditsOnCanvas(edits, () => setSelectedId(null));
  useEffect(() => {
    if (edit.shown) setChangesOpen(false);
  }, [edit.shown?.permissionId]);
  const selectedIndex = edit.shown ? -1 : newestFirst.findIndex(({ id }) => id === selectedId);
  const selected = newestFirst[selectedIndex];
  const somethingElseShown = Boolean(selected || edit.shown);
  const changesShown = changesOpen || !somethingElseShown;
  const outcome = selected && outcomeOf(selected);
  const questionNote = useClearWhenSettled(selected, () => setSelectedId(null));
  const settledNote = edit.note ?? questionNote;
  const older = selected ? newestFirst[selectedIndex + 1] : newest;
  const newer = selected ? newestFirst[selectedIndex - 1] : undefined;
  const pick = (id: string) => {
    setSelectedId(id);
    setHistoryOpen(false);
    setChangesOpen(false);
    edit.setAside();
    placeForReview(items.find((item) => item.id === id));
  };
  const closeHistoryOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !historyOpen) return;
    event.preventDefault();
    setHistoryOpen(false);
  };

  return (
    <aside className="canvas-panel" onKeyDown={closeHistoryOnEscape}>
      <div className="canvas-header" data-pane-bar>
        <PaneGrip pane="canvas" />
        {changesOpen ? (
          <span className="canvas-title">Changes</span>
        ) : edit.shown ? (
          <>
            <span className="canvas-kind">✎</span>
            <span className="canvas-title">{edit.shown.title}</span>
            <span className="canvas-outcome status-waiting">needs your answer</span>
          </>
        ) : selected ? (
          <>
            <span className="canvas-kind">{kindIcons[selected.kind]}</span>
            <span className="canvas-title">{selected.title}</span>
            {outcome && (
              <span className={`canvas-outcome status-${selected.status}${selected.review ? " verdict" : ""}`} title={outcome}>
                {outcome}
              </span>
            )}
          </>
        ) : (
          <span className="canvas-title empty-title">Canvas</span>
        )}
        {(changesOpen || !edit.shown) && edit.waiting > 0 && (
          <button
            type="button"
            className="canvas-outcome status-waiting edits-waiting"
            data-hint={hints.canvasEditsWaiting}
            onClick={() => {
              setChangesOpen(false);
              edit.bringBack();
            }}
          >
            {edit.waiting === 1 ? "1 edit waiting" : `${edit.waiting} edits waiting`}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="icon canvas-nav" aria-label="Older" data-hint={hints.canvasOlder} disabled={!older} onClick={() => older && pick(older.id)}>
          ‹
        </button>
        <button type="button" className="icon canvas-nav" aria-label="Newer" data-hint={hints.canvasNewer} disabled={!newer} onClick={() => newer && pick(newer.id)}>
          ›
        </button>
        <button
          type="button"
          className={`changes-toggle ${changesShown ? "on" : ""}`}
          aria-pressed={changesShown}
          data-hint={hints.canvasChanges}
          disabled={!somethingElseShown}
          onClick={() => setChangesOpen((open) => !open)}
        >
          Changes
        </button>
        <button
          type="button"
          className={`history-toggle ${historyOpen ? "on" : ""}`}
          aria-expanded={historyOpen}
          data-hint={hints.canvasHistory}
          disabled={items.length === 0}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          History ({items.length})
        </button>
        <button
          type="button"
          className="canvas-clear"
          data-hint={hints.canvasClear}
          disabled={!somethingElseShown}
          onClick={() => {
            setSelectedId(null);
            setChangesOpen(false);
            edit.setAside();
            placeForReview(undefined);
          }}
        >
          Clear
        </button>
        <FullscreenToggle pane="canvas" />
        <button type="button" className="link canvas-hide" data-hint={hints.canvasHide} data-shortcut={shortcutKeys().toggleCanvas} onClick={onHide}>
          Hide
        </button>
      </div>
      {historyOpen && <CanvasHistory items={newestFirst} selectedId={selected?.id ?? null} onPick={pick} />}
      <div className="canvas-body">
        {changesShown && (
          <>
            {!somethingElseShown && (
              <div className="empty-state">
                <SettledNoteLine note={settledNote} />
                {items.length === 0
                  ? "When the agent shows something or asks you to choose, it appears here."
                  : "Nothing on the canvas right now. Earlier drawings and questions are in History."}
              </div>
            )}
            <ChangesView conversationId={conversationId} refreshPoint={changesRefreshPoint} />
          </>
        )}
        {!changesOpen && edit.shown && (
          <EditApproval key={edit.shown.permissionId} request={edit.shown} moreWaiting={edit.waiting - 1} note={settledNote} conversationId={conversationId} />
        )}
        {!changesOpen && selected?.kind === "show" && (
          <CanvasFrame
            key={selected.id}
            frameId={selected.id}
            html={selected.html ?? ""}
            assetsOrigin={assetsOrigin}
            className="show"
            onRendered={reportRender(selected.id)}
          />
        )}
        {!changesOpen && selected?.kind === "review" && selected.review && (
          <WalkthroughView key={selected.id} item={selected as ReviewItem} conversationId={selected.conversationId} />
        )}
        {!changesOpen && selected?.kind === "tour" && selected.tour && (
          <WalkthroughView key={selected.id} item={selected as TourItem} conversationId={selected.conversationId} />
        )}
        {!changesOpen && selected?.kind === "ask" && (
          <AskView
            key={selected.id}
            item={selected}
            pagesBefore={items.filter(({ id }) => selected.shownBefore?.includes(id))}
            assetsOrigin={assetsOrigin}
          />
        )}
      </div>
    </aside>
  );
}
