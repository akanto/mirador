import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { hints } from "./hints.ts";

const MIN_PANEL_WIDTH = 240;
const DEFAULT_CHAT_SHARE = 0.45;
const KEYBOARD_STEP = 0.03;
const STORAGE_KEY = "mirador.chatShare";

function loadChatShare() {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return stored > 0 && stored < 1 ? stored : DEFAULT_CHAT_SHARE;
  } catch {
    return DEFAULT_CHAT_SHARE;
  }
}

function saveChatShare(share: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(share));
  } catch {}
}

/** The chat column's share of the space it splits with the canvas, remembered per browser. */
export function useChatCanvasSplit() {
  const [chatShare, setChatShare] = useState(loadChatShare);
  useEffect(() => saveChatShare(chatShare), [chatShare]);
  return [chatShare, setChatShare] as const;
}

export function splitColumns(chatShare: number) {
  return `var(--sidebar-width) minmax(0, ${chatShare}fr) var(--splitter-width) minmax(0, ${1 - chatShare}fr)`;
}

/** Sits between the chat column (previous sibling) and the canvas panel (next sibling). */
export function Splitter({ chatShare, onChange }: { chatShare: number; onChange: (share: number) => void }) {
  const handle = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    document.body.classList.toggle("resizing", dragging);
  }, [dragging]);

  const splitArea = () => {
    const chatColumn = handle.current!.previousElementSibling!.getBoundingClientRect();
    const canvasPanel = handle.current!.nextElementSibling!.getBoundingClientRect();
    return { left: chatColumn.left, width: chatColumn.width + canvasPanel.width };
  };

  const withinLimits = (share: number) => {
    const { width } = splitArea();
    const minimumShare = Math.min(MIN_PANEL_WIDTH / width, 0.5);
    return Math.min(Math.max(share, minimumShare), 1 - minimumShare);
  };

  const shareAtPointer = (clientX: number) => {
    const { left, width } = splitArea();
    return withinLimits((clientX - left) / width);
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    handle.current!.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging) onChange(shareAtPointer(event.clientX));
  };

  const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
    handle.current!.releasePointerCapture(event.pointerId);
    setDragging(false);
  };

  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!direction) return;
    event.preventDefault();
    onChange(withinLimits(chatShare + direction * KEYBOARD_STEP));
  };

  return (
    <div
      ref={handle}
      className={`splitter ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat and canvas"
      aria-valuenow={Math.round(chatShare * 100)}
      tabIndex={0}
      data-hint={hints.splitter}
      onPointerDown={startDrag}
      onPointerMove={drag}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onDoubleClick={() => onChange(DEFAULT_CHAT_SHARE)}
      onKeyDown={nudge}
    />
  );
}
