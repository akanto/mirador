import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { buildCanvasDocument, isCanvasFrameMessage } from "../shared/canvas-document.ts";
import type { AskOption, CanvasItem } from "../shared/model.ts";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";
import { shortcutKeys } from "./shortcuts.ts";
import { formatClockTime, formatFullTime } from "./timestamps.ts";
import { useTypingAidAttributes } from "./typing-aids.ts";
import { ReviewView, type ReviewItem } from "./Review.tsx";
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
  const document = useMemo(() => buildCanvasDocument(html, frameId, assetsOrigin), [html, frameId, assetsOrigin]);
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

  const fitted = fitsContent ? fittedStyles(contentSize, roomWidth) : {};
  return (
    <div ref={box} className={`canvas-frame ${className ?? ""}`} style={fitted.box}>
      <iframe ref={frame} sandbox="allow-scripts" srcDoc={document} title={frameId} style={fitted.frame} />
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

function reportRender(itemId: string) {
  return (errors: string[]) => connection.send({ type: "canvas.report", itemId, errors });
}

const SOMETHING_ELSE = Symbol("something else");

function AskView({ item, pagesBefore, assetsOrigin }: { item: CanvasItem; pagesBefore: CanvasItem[]; assetsOrigin: string }) {
  const [choice, setChoice] = useState<string | typeof SOMETHING_ELSE | null>(null);
  const [other, setOther] = useState("");
  const [note, setNote] = useState("");
  const typingAidAttributes = useTypingAidAttributes();
  const waiting = item.status === "waiting";
  const options: AskOption[] = item.options ?? [];
  const answer = choice === SOMETHING_ELSE ? other.trim() : choice;
  const [previewWidths, setPreviewWidths] = useState<Record<string, number>>({});
  const widestPreview = Math.max(0, ...Object.values(previewWidths));
  const optionsStyle = widestPreview > 0 ? ({ "--preview-width": `${widestPreview}px` } as CSSProperties) : undefined;
  const isChosen = (label: string) => (waiting ? choice === label : item.answer?.label === label);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (answer) connection.send({ type: "ask.answer", itemId: item.id, label: answer, note: note.trim() || undefined });
  };

  return (
    <form className="ask" onSubmit={submit}>
      <h3>{item.question}</h3>
      {item.status === "answered" && item.answer && (
        <div className="ask-answer">
          You chose <strong>{item.answer.label}</strong>
          {item.answer.note && <> — “{item.answer.note}”</>}
          <span className="delivered">
            {item.answer.deliveredAs === "tool-result" ? " (returned to the agent)" : " (sent as your next message)"}
          </span>
        </div>
      )}
      {item.status === "cancelled" && <div className="ask-answer">This question was withdrawn.</div>}
      {pagesBefore.map((page) => (
        <section key={page.id} className="ask-page-before" aria-label={`Shown before the question: ${page.title}`}>
          <div className="ask-page-before-title" data-hint={hints.askPageBefore}>
            Shown just before: {page.title}
          </div>
          <CanvasFrame frameId={`${item.id}-before-${page.id}`} html={page.html ?? ""} assetsOrigin={assetsOrigin} className="ask-context" fitsContent />
        </section>
      ))}
      {item.html && <CanvasFrame frameId={`${item.id}-context`} html={item.html} assetsOrigin={assetsOrigin} className="ask-context" fitsContent />}
      <div className="ask-options" role="radiogroup" aria-label={item.question} style={optionsStyle}>
        {options.map((option, index) => (
          <label key={option.label} className={`ask-option ${isChosen(option.label) ? "chosen" : ""}`}>
            <span className="ask-option-head">
              <input
                type="radio"
                name={`ask-${item.id}`}
                aria-label={option.label}
                checked={isChosen(option.label)}
                disabled={!waiting}
                onChange={() => setChoice(option.label)}
              />
              <span className="ask-option-label">{option.label}</span>
            </span>
            {option.description && <span className="ask-option-description">{option.description}</span>}
            {option.html && (
              <CanvasFrame
                frameId={`${item.id}-option-${index}`}
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
          {item.allowOther && (
            <label className={`ask-other ${choice === SOMETHING_ELSE ? "chosen" : ""}`}>
              <input
                type="radio"
                name={`ask-${item.id}`}
                aria-label="Something else"
                checked={choice === SOMETHING_ELSE}
                onChange={() => setChoice(SOMETHING_ELSE)}
              />
              <input
                {...typingAidAttributes}
                value={other}
                placeholder="Something else…"
                aria-label="Your own answer"
                onFocus={() => setChoice(SOMETHING_ELSE)}
                onChange={(event) => setOther(event.target.value)}
              />
            </label>
          )}
          <textarea {...typingAidAttributes} value={note} placeholder="Optional note for the agent (sent with your answer)" onChange={(event) => setNote(event.target.value)} />
        </div>
      )}
      {waiting && (
        <div className="ask-submit">
          <span className="ask-selection">{answer ? <>Your answer: <strong>{answer}</strong></> : "Pick an option to answer"}</span>
          <button type="submit" className="primary" disabled={!answer}>
            Submit
          </button>
        </div>
      )}
    </form>
  );
}

const kindIcons: Record<CanvasItem["kind"], string> = { show: "▣", ask: "?", review: "⇄" };

function outcomeOf(item: CanvasItem) {
  if (item.review) return item.review.verdict;
  if (item.status === "waiting") return "needs your answer";
  if (item.status === "cancelled") return "withdrawn";
  if (item.status === "answered" && item.answer) return `→ ${item.answer.label}`;
  return "";
}

/** Once a question is answered or withdrawn, it has had its turn on the canvas. */
const isSettledQuestion = (item: CanvasItem) => item.kind === "ask" && item.status !== "waiting";

function settledMessage(item: CanvasItem) {
  return item.status === "answered" ? `✓ Answer sent: “${item.answer?.label ?? ""}”` : "The agent withdrew its question.";
}

/** Clears the canvas when the question on it gets settled, leaving a short note of what happened. */
function useClearWhenSettled(selected: CanvasItem | undefined, clear: () => void) {
  const [note, setNote] = useState<string | null>(null);
  const previous = useRef<{ id: string; status: CanvasItem["status"] } | null>(null);
  useEffect(() => {
    const wasWaiting = previous.current?.id === selected?.id && previous.current?.status === "waiting";
    previous.current = selected ? { id: selected.id, status: selected.status } : null;
    if (selected && wasWaiting && isSettledQuestion(selected)) {
      setNote(settledMessage(selected));
      clear();
    }
  }, [selected?.id, selected?.status]);
  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(timer);
  }, [note]);
  return note;
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

export function CanvasPanel({ items, assetsOrigin, onHide }: { items: CanvasItem[]; assetsOrigin: string; onHide: () => void }) {
  const newestFirst = useMemo(() => [...items].sort((a, b) => b.createdAt - a.createdAt), [items]);
  const newest = newestFirst[0];
  const onCanvasByDefault = newest && !isSettledQuestion(newest) ? newest.id : null;
  const [selectedId, setSelectedId] = useState<string | null>(onCanvasByDefault);
  const [historyOpen, setHistoryOpen] = useState(false);
  const placeForReview = useReviewPlacement();
  useEffect(() => {
    setSelectedId(onCanvasByDefault);
    if (takeArrivedReview(newest)) placeForReview(newest);
  }, [newest?.id]);
  const selectedIndex = newestFirst.findIndex(({ id }) => id === selectedId);
  const selected = newestFirst[selectedIndex];
  const outcome = selected && outcomeOf(selected);
  const settledNote = useClearWhenSettled(selected, () => setSelectedId(null));
  const older = selected ? newestFirst[selectedIndex + 1] : newest;
  const newer = selected ? newestFirst[selectedIndex - 1] : undefined;
  const pick = (id: string) => {
    setSelectedId(id);
    setHistoryOpen(false);
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
        {selected ? (
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
        <span className="spacer" />
        <button type="button" className="icon canvas-nav" aria-label="Older" data-hint={hints.canvasOlder} disabled={!older} onClick={() => older && pick(older.id)}>
          ‹
        </button>
        <button type="button" className="icon canvas-nav" aria-label="Newer" data-hint={hints.canvasNewer} disabled={!newer} onClick={() => newer && pick(newer.id)}>
          ›
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
          disabled={!selected}
          onClick={() => {
            setSelectedId(null);
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
        {!selected && (
          <div className="empty">
            {settledNote && (
              <div className="settled-note" role="status">
                {settledNote}
              </div>
            )}
            {items.length === 0
              ? "When the agent shows something or asks you to choose, it appears here."
              : "Nothing on the canvas right now. Earlier drawings and questions are in History."}
          </div>
        )}
        {selected?.kind === "show" && (
          <CanvasFrame
            key={selected.id}
            frameId={selected.id}
            html={selected.html ?? ""}
            assetsOrigin={assetsOrigin}
            className="show"
            onRendered={reportRender(selected.id)}
          />
        )}
        {selected?.kind === "review" && selected.review && (
          <ReviewView key={selected.id} item={selected as ReviewItem} conversationId={selected.conversationId} />
        )}
        {selected?.kind === "ask" && (
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
