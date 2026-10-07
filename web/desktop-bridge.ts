import { DESKTOP_NONCE_EVENT, type DesktopMenuMessage } from "../shared/desktop-menu.ts";

declare global {
  interface Window {
    __electrobunSendToHost?: (message: DesktopMenuMessage) => void;
  }
}

/** Electrobun gives the desktop app's window, and only it, a way to message the app. */
export const inDesktopApp = () => typeof window.__electrobunSendToHost === "function";

export const sendToDesktopApp = (message: DesktopMenuMessage) => window.__electrobunSendToHost?.(message);

let nonce: string | null = null;

/** The app hands the nonce that makes it act to its window's own page only, never to a frame; an app built before that hands none. */
export function askDesktopAppForNonce() {
  if (!inDesktopApp() || window.parent !== window) return;
  window.addEventListener(DESKTOP_NONCE_EVENT, (event) => (nonce = (event as CustomEvent<string>).detail));
  sendToDesktopApp({ type: "desktop-nonce-request" });
}

export const desktopNonce = () => nonce;
