import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { movedBefore } from "../shared/sidebar-order.ts";

const DRAG_AFTER_PX = 4;
const NOT_A_DRAG_HANDLE = "button, a, input, select, textarea, label, [contenteditable]";

interface Drag {
  id: string;
  /** The item it would land just before, or null for last. */
  beforeId: string | null;
  changesOrder: boolean;
}

const itemsOf = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(":scope > [data-reorder-id]")];

function idBelow(list: HTMLElement, y: number) {
  const below = itemsOf(list).find((item) => {
    const { top, height } = item.getBoundingClientRect();
    return y < top + height / 2;
  });
  return below?.dataset.reorderId ?? null;
}

function changesOrder(list: HTMLElement, id: string, beforeId: string | null) {
  const ids = itemsOf(list).map((item) => item.dataset.reorderId!);
  return movedBefore(ids, id, beforeId).join() !== ids.join();
}

const preventTextSelection = (event: Event) => event.preventDefault();

/** The pointer ends a drag with a click on whatever it was over, which is not meant to open or rename that. */
function swallowNextClick() {
  const swallow = (click: MouseEvent) => {
    click.stopPropagation();
    click.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }));
}

/**
 * Reorders a list's items, the children marked data-reorder-id, by dragging one to another place: the gap nearest the
 * pointer's height is where it lands. Dragging starts only once the pointer moves a few pixels, so clicks and
 * double-clicks keep working, and Esc cancels it.
 */
export function useDragToReorder(onMove: (id: string, beforeId: string | null) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);

  const startDrag = (id: string, list: HTMLElement | null, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !list || (event.target as Element).closest(NOT_A_DRAG_HANDLE)) return;
    const start = { x: event.clientX, y: event.clientY };
    let latest: Drag | null = null;
    document.addEventListener("selectstart", preventTextSelection);
    const follow = (move: PointerEvent) => {
      if (!latest && Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_AFTER_PX) return;
      if (!latest) {
        document.body.classList.add("reordering");
        window.getSelection()?.removeAllRanges();
      }
      const beforeId = idBelow(list, move.clientY);
      latest = { id, beforeId, changesOrder: changesOrder(list, id, beforeId) };
      setDrag(latest);
    };
    const finish = (drop: boolean) => {
      window.removeEventListener("pointermove", follow);
      window.removeEventListener("pointerup", dropHere);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", cancelOnEscape, true);
      document.removeEventListener("selectstart", preventTextSelection);
      if (!latest) return;
      document.body.classList.remove("reordering");
      swallowNextClick();
      setDrag(null);
      if (drop && latest.changesOrder) onMove(latest.id, latest.beforeId);
    };
    const dropHere = () => finish(true);
    const cancel = () => finish(false);
    const cancelOnEscape = (key: KeyboardEvent) => {
      if (key.key !== "Escape" || !latest) return;
      key.preventDefault();
      key.stopPropagation();
      cancel();
    };
    window.addEventListener("pointermove", follow);
    window.addEventListener("pointerup", dropHere);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", cancelOnEscape, true);
  };

  /** The classes an item takes while a drag is on: faded when it is the one dragged, a line where it would land. */
  const classesOf = (itemId: string, isLast: boolean) =>
    [
      drag?.id === itemId && "dragged",
      drag?.changesOrder && drag.beforeId === itemId && "drop-before",
      drag?.changesOrder && drag.beforeId === null && isLast && "drop-after",
    ].filter((name): name is string => Boolean(name));

  return { startDrag, classesOf };
}
