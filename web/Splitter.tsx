import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { hints } from "./hints.ts";

const MIN_PANEL_WIDTH = 240;
export const DEFAULT_CHAT_SHARE = 0.45;
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

/** Sits between two panes, its previous and next siblings; `share` is the first pane's part of their combined width. */
export function Splitter({
  share,
  onChange,
  label,
  resetShare,
  minimumWidth = MIN_PANEL_WIDTH,
}: {
  share: number;
  onChange: (share: number) => void;
  label: string;
  resetShare: number;
  minimumWidth?: number;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    document.body.classList.toggle("resizing", dragging);
  }, [dragging]);

  const splitArea = () => {
    const first = handle.current!.previousElementSibling!.getBoundingClientRect();
    const second = handle.current!.nextElementSibling!.getBoundingClientRect();
    return { left: first.left, width: first.width + second.width };
  };

  const withinLimits = (share: number) => {
    const { width } = splitArea();
    const minimumShare = Math.min(minimumWidth / width, 0.5);
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
    onChange(withinLimits(share + direction * KEYBOARD_STEP));
  };

  return (
    <div
      ref={handle}
      className={`splitter ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      data-hint={hints.splitter}
      onPointerDown={startDrag}
      onPointerMove={drag}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onDoubleClick={() => onChange(resetShare)}
      onKeyDown={nudge}
    />
  );
}
