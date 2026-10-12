import { useEffect, useState } from "react";
import { DESKTOP_NONCE_EVENT, DESKTOP_UPDATE_EVENT, type DesktopMenuMessage, type DesktopUpdate } from "../shared/desktop-menu.ts";

declare global {
  interface Window {
    __electrobunSendToHost?: (message: DesktopMenuMessage) => void;
  }
}

/** Electrobun gives the desktop app's window, and only it, a way to message the app. */
export const inDesktopApp = () => typeof window.__electrobunSendToHost === "function";

export const sendToDesktopApp = (message: DesktopMenuMessage) => window.__electrobunSendToHost?.(message);

let nonce: string | null = null;
let currentDesktopUpdate: DesktopUpdate | null = null;

if (typeof window !== "undefined") {
  window.addEventListener(DESKTOP_NONCE_EVENT, (event) => {
    nonce = (event as CustomEvent<string>).detail;
  });
  window.addEventListener(DESKTOP_UPDATE_EVENT, (event) => {
    currentDesktopUpdate = (event as CustomEvent<DesktopUpdate | null>).detail ?? null;
  });
}

/** The app hands the nonce that makes it act to its window's own page only, never to a frame; an app built before that hands none. */
export function askDesktopAppForNonce() {
  if (!inDesktopApp() || window.parent !== window) return;
  sendToDesktopApp({ type: "desktop-nonce-request" });
}

export const desktopNonce = () => nonce;

export function restartToUpdate() {
  const currentNonce = desktopNonce();
  if (currentNonce) sendToDesktopApp({ type: "desktop-action", nonce: currentNonce, action: "install-update" });
}

export function useDesktopUpdate(): DesktopUpdate | null {
  const [update, setUpdate] = useState<DesktopUpdate | null>(currentDesktopUpdate);
  useEffect(() => {
    const onUpdate = (event: Event) => {
      const next = (event as CustomEvent<DesktopUpdate | null>).detail ?? null;
      currentDesktopUpdate = next;
      setUpdate(next);
    };
    window.addEventListener(DESKTOP_UPDATE_EVENT, onUpdate);
    return () => window.removeEventListener(DESKTOP_UPDATE_EVENT, onUpdate);
  }, []);
  return update;
}
