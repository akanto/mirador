import { useEffect, useRef, type RefObject } from "react";
import { DESKTOP_CLOSE_EVENT } from "../shared/desktop-menu.ts";
import { desktopNonce, inDesktopApp, sendToDesktopApp } from "./desktop-bridge.ts";

/** Closes what it stands for and says so, or says no and leaves ⌘W to the next. */
type Closer = () => boolean;

const focusedClosers = new Set<RefObject<Closer>>();
const dialogClosers = new Set<RefObject<Closer>>();

function useCloser(closers: Set<RefObject<Closer>>, closer: Closer) {
  const latest = useRef(closer);
  latest.current = closer;
  useEffect(() => {
    closers.add(latest);
    return () => void closers.delete(latest);
  }, [closers]);
}

/** A terminal closes its shell while focus is in it. */
export const useClosesWhileFocused = (closer: Closer) => useCloser(focusedClosers, closer);

/** When nothing focused takes it, the open dialog closes, the one opened last first. */
export const useClosesAsDialog = (closer: Closer) => useCloser(dialogClosers, closer);

function closeWhatHasFocus() {
  const closers = [...focusedClosers, ...[...dialogClosers].reverse()];
  if (closers.some((closer) => closer.current())) return;
  const nonce = desktopNonce();
  if (nonce) sendToDesktopApp({ type: "desktop-close-window", nonce });
}

/**
 * The macOS app's ⌘W comes here through its menu, whether or not the page saw the key, and from wherever focus is, a
 * canvas frame included. With nothing inside to close, the app asks before it closes the window.
 */
export function closeWhatHasFocusOnCommandW() {
  if (inDesktopApp() && window.parent === window) window.addEventListener(DESKTOP_CLOSE_EVENT, closeWhatHasFocus);
}
