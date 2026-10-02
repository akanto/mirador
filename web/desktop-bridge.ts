import type { DesktopMenuMessage } from "../shared/desktop-menu.ts";

declare global {
  interface Window {
    __electrobunSendToHost?: (message: DesktopMenuMessage) => void;
  }
}

/** Electrobun gives the desktop app's window, and only it, a way to message the app. */
export const inDesktopApp = () => typeof window.__electrobunSendToHost === "function";

export const sendToDesktopApp = (message: DesktopMenuMessage) => window.__electrobunSendToHost?.(message);
