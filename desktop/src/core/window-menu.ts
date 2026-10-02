import { DESKTOP_MENU_EVENT, type DesktopMenu, type DesktopMenuItem } from "../../../shared/desktop-menu.ts";
import { isTrayAction, trayMenu, type TrayAction, type TrayState } from "./tray-menu.ts";

/** The tray's menu, less Open, which the window it would show is already showing. */
export const windowMenu = (state: TrayState): DesktopMenuItem[] =>
  trayMenu(state).filter((item) => item.type === "separator" || item.action !== "open");

export const showMenuScript = (menu: DesktopMenu) =>
  `window.dispatchEvent(new CustomEvent(${JSON.stringify(DESKTOP_MENU_EVENT)}, { detail: ${JSON.stringify(menu)} }))`;

export type PageRequest = { type: "menu" } | { type: "action"; action: TrayAction };

/**
 * Any frame in the window can post to the app, the agents' canvas pages included; only the page the app handed the
 * nonce to can make it act, and the canvas frames, from another origin, never see it.
 */
export function pageRequest(detail: unknown, nonce: string): PageRequest | null {
  if (typeof detail !== "object" || detail === null) return null;
  const message = detail as Record<string, unknown>;
  if (message.type === "desktop-menu-request") return { type: "menu" };
  if (message.type === "desktop-action" && message.nonce === nonce && isTrayAction(message.action)) return { type: "action", action: message.action };
  return null;
}
