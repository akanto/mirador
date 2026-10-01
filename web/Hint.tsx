import { useEffect, useLayoutEffect, useRef, useState } from "react";

const SHOW_DELAY_MS = 350;
const GAP = 6;
const EDGE = 8;

interface Hint {
  text: string;
  anchor: DOMRect;
}

const hintedElementAt = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-hint]") : null);

/**
 * Shows the `data-hint` text of whatever is pointed at or focused with the keyboard, one hint at a time.
 * Pressing an element puts its hint away until the pointer moves to something else or the element loses focus.
 */
export function HintLayer() {
  const [hint, setHint] = useState<Hint | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    let dismissed: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer);
      current = null;
      visible = false;
      setHint(null);
    };
    const showFor = (element: HTMLElement, delay: number) => {
      clearTimeout(timer);
      current = element;
      timer = setTimeout(() => {
        const text = element.dataset.hint;
        if (!text || !element.isConnected) return;
        visible = true;
        setHint({ text, anchor: element.getBoundingClientRect() });
      }, delay);
    };
    const onPointerDown = (event: PointerEvent) => {
      dismissed = hintedElementAt(event.target);
      hide();
    };
    const onPointerOver = (event: PointerEvent) => {
      const element = hintedElementAt(event.target);
      if (element !== dismissed) dismissed = null;
      if (element === current) return;
      if (element && element !== dismissed) showFor(element, visible ? 0 : SHOW_DELAY_MS);
      else hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const element = hintedElementAt(event.target);
      if (element && element !== dismissed && event.target instanceof Element && event.target.matches(":focus-visible")) showFor(element, 0);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.target instanceof Node && dismissed?.contains(event.target)) dismissed = null;
      hide();
    };
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && hide();
    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    const element = bubble.current;
    if (!hint || !element) return;
    element.style.left = "0px";
    element.style.top = "0px";
    const { width, height } = element.getBoundingClientRect();
    const fitsBelow = hint.anchor.bottom + GAP + height <= window.innerHeight - EDGE;
    const top = fitsBelow ? hint.anchor.bottom + GAP : hint.anchor.top - GAP - height;
    const left = Math.min(Math.max(EDGE, hint.anchor.left), window.innerWidth - width - EDGE);
    element.style.top = `${Math.max(EDGE, top)}px`;
    element.style.left = `${left}px`;
    element.style.visibility = "visible";
  }, [hint]);

  if (!hint) return null;
  const [summary, ...details] = hint.text.split("\n\n");
  return (
    <div ref={bubble} className="hint-bubble" role="tooltip" style={{ visibility: "hidden" }}>
      {details.length > 0 ? <strong>{summary}</strong> : summary}
      {details.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </div>
  );
}
