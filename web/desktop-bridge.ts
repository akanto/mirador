import { useSyncExternalStore } from "react";
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
let readyUpdate: DesktopUpdate | null = null;
const readyUpdateListeners = new Set<() => void>();

function takeReadyUpdate(event: Event) {
  readyUpdate = (event as CustomEvent<DesktopUpdate | null>).detail ?? null;
  readyUpdateListeners.forEach((listener) => listener());
}

/**
 * The app hands the nonce that makes it act to its window's own page only, never to a frame; an app built before that
 * hands none. With the nonce it tells the page of an update it has ready to install.
 */
export function askDesktopAppForNonce() {
  if (!inDesktopApp() || window.parent !== window) return;
  window.addEventListener(DESKTOP_NONCE_EVENT, (event) => (nonce = (event as CustomEvent<string>).detail));
  window.addEventListener(DESKTOP_UPDATE_EVENT, takeReadyUpdate);
  sendToDesktopApp({ type: "desktop-nonce-request" });
}

export const desktopNonce = () => nonce;

export function restartToUpdate() {
  const currentNonce = desktopNonce();
  if (currentNonce) sendToDesktopApp({ type: "desktop-action", nonce: currentNonce, action: "install-update" });
}

function subscribeToReadyUpdate(listener: () => void) {
  readyUpdateListeners.add(listener);
  return () => void readyUpdateListeners.delete(listener);
}

/** The update the desktop app downloaded and can restart into; always null in a browser tab. */
export const useReadyUpdate = () => useSyncExternalStore(subscribeToReadyUpdate, () => readyUpdate);
