/** The desktop app's menu, shown inside its window on Linux, which has no menu bar and may show no tray icon. */
export type DesktopMenuItem =
  | { type: "separator" }
  | { type: "normal"; label: string; action?: string; enabled?: boolean; checked?: boolean };

export interface DesktopMenu {
  nonce: string;
  items: DesktopMenuItem[];
}

/** The app dispatches this on the page's window, which canvas frames from another origin cannot listen to. */
export const DESKTOP_MENU_EVENT = "mirador:desktop-menu";

/** The app hands its window's own page the nonce with this event; only that page then makes the app act or open links. */
export const DESKTOP_NONCE_EVENT = "mirador:desktop-nonce";

export type DesktopMenuMessage =
  | { type: "desktop-menu-request" }
  | { type: "desktop-action"; nonce: string; action: string }
  | { type: "desktop-nonce-request" }
  | { type: "desktop-open-link"; nonce: string; url: string };
