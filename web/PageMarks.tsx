import { useEffect, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { canvasMarkDoneMessage, canvasPointMessage, type CanvasFrameMessage } from "../shared/canvas-document.ts";
import type { ShowItem } from "../shared/model.ts";
import { pageMarkFrom, pageMarkLabel, pageMarkPrompt, type MarkIntent, type PageMark } from "../shared/page-marks.ts";
import { useEnterWhileBusy } from "./busy-sending.ts";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";
import { isMac, keyLabels } from "./shortcuts.ts";
import { useTypingAidAttributes } from "./typing-aids.ts";
import { usePaneFullscreen } from "./Workspace.tsx";

const SENT_NOTE_MS = 8000;

function useFadingSentNote() {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(null), SENT_NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);
  return [note, setNote] as const;
}

const sentNoteFor = (label: string, intent: MarkIntent) =>
  intent === "change" ? `Asked the agent to change ${label}. The new page comes on the canvas.` : `Asked about ${label}. The answer comes in the chat.`;

/**
 * Marking part of the page the agent showed, to ask about it or have it changed: point mode, which the canvas bar turns
 * on, the mark the page reports, and the box for the user's words, which sends them with the mark to the page's agent.
 */
export function usePageMarks(page: ShowItem | undefined, frame: RefObject<HTMLIFrameElement | null>): {
  pointing: boolean;
  point: (on: boolean) => void;
  received: (message: CanvasFrameMessage) => void;
  opened: ReactNode;
} {
  const [pointing, setPointing] = useState(false);
  const [mark, setMark] = useState<PageMark | null>(null);
  const [sentNote, setSentNote] = useFadingSentNote();
  const enterWhileBusy = useEnterWhileBusy();
  const fullscreen = usePaneFullscreen("canvas");
  useEffect(() => {
    setPointing(false);
    setMark(null);
  }, [page?.id]);

  const postToPage = (message: object) => frame.current?.contentWindow?.postMessage(message, "*");
  const point = (on: boolean) => {
    setPointing(on);
    postToPage(canvasPointMessage(on));
  };
  const finishMark = () => {
    setMark(null);
    postToPage(canvasMarkDoneMessage());
  };
  const received = (message: CanvasFrameMessage) => {
    if (message.kind === "pointing") setPointing(false);
    if (message.kind !== "mark") return;
    const reported = pageMarkFrom(message.mark);
    if (!reported) return;
    setPointing(false);
    setSentNote(null);
    setMark(reported);
  };
  const send = (words: string, intent: MarkIntent) => {
    if (!page || !mark) return;
    const text = pageMarkPrompt(page.title, mark, words, intent);
    if (!connection.send({ type: "conversation.prompt", conversationId: page.conversationId, text, imageIds: [], afterTurn: enterWhileBusy === "after-turn" })) return;
    setSentNote(sentNoteFor(pageMarkLabel(mark), intent));
    finishMark();
  };

  const opened = page && (
    <>
      {mark && <MarkWordsBox key={JSON.stringify(mark)} label={pageMarkLabel(mark)} onSend={send} onClose={finishMark} />}
      {sentNote && (
        <div className="page-mark-sent" role="status">
          {sentNote}
          {fullscreen?.isFullscreen && (
            <button type="button" className="link" onClick={() => fullscreen.setFullscreen(false)}>
              Show the chat
            </button>
          )}
        </div>
      )}
    </>
  );
  return { pointing, point, received, opened };
}

function MarkWordsBox({ label, onSend, onClose }: { label: string; onSend: (words: string, intent: MarkIntent) => void; onClose: () => void }) {
  const [words, setWords] = useState("");
  const typingAidAttributes = useTypingAidAttributes();
  const { primary } = keyLabels();
  const sendOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (words.trim()) onSend(words, (isMac ? event.metaKey : event.ctrlKey) ? "change" : "ask");
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="page-mark-box" role="dialog" aria-label="Ask the agent about what you marked">
      <div className="ask-about-label">Ask the agent about {label}, or tell it what to change there</div>
      <textarea
        {...typingAidAttributes}
        autoFocus
        value={words}
        rows={2}
        placeholder={`Your words (Enter asks, ${primary}Enter changes the page, Shift+Enter for a new line, Esc cancels)`}
        onChange={(event) => setWords(event.target.value)}
        onKeyDown={sendOnEnter}
      />
      <div className="ask-about-actions">
        <button type="button" className="primary" disabled={!words.trim()} onClick={() => onSend(words, "ask")}>
          Ask
        </button>
        <button type="button" disabled={!words.trim()} onClick={() => onSend(words, "change")} data-hint={hints.pageMarkChange}>
          Change
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
