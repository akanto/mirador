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

export type DesktopMenuMessage = { type: "desktop-menu-request" } | { type: "desktop-action"; nonce: string; action: string };
