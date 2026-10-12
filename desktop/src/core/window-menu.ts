import {
  DESKTOP_CLOSE_EVENT,
  DESKTOP_MENU_EVENT,
  DESKTOP_NONCE_EVENT,
  DESKTOP_UPDATE_EVENT,
  isDesktopAppearance,
  type DesktopAppearance,
  type DesktopMenu,
  type DesktopMenuItem,
  type DesktopUpdate,
} from "../../../shared/desktop-menu.ts";
import { webUrl } from "./navigation.ts";
import { isTrayAction, trayMenu, type TrayAction, type TrayState } from "./tray-menu.ts";

/** The tray's menu, less Open, which the window it would show is already showing. */
export const windowMenu = (state: TrayState): DesktopMenuItem[] =>
  trayMenu(state).filter((item) => item.type === "separator" || item.action !== "open");

export const showMenuScript = (menu: DesktopMenu) =>
  `window.dispatchEvent(new CustomEvent(${JSON.stringify(DESKTOP_MENU_EVENT)}, { detail: ${JSON.stringify(menu)} }))`;

export const showUpdateScript = (update: DesktopUpdate | null) =>
  `window.dispatchEvent(new CustomEvent(${JSON.stringify(DESKTOP_UPDATE_EVENT)}, { detail: ${JSON.stringify(update)} }))`;

export const giveNonceScript = (nonce: string) => `window.dispatchEvent(new CustomEvent(${JSON.stringify(DESKTOP_NONCE_EVENT)}, { detail: ${JSON.stringify(nonce)} }))`;

export const closeWhatHasFocusScript = `window.dispatchEvent(new CustomEvent(${JSON.stringify(DESKTOP_CLOSE_EVENT)}))`;

/** Where the window shows the tray's menu (Linux) the page runs any of its actions; elsewhere only the restart into an update. */
export const pageMayRun = (action: TrayAction, menuInWindow: boolean) => menuInWindow || action === "install-update";

export type PageRequest =
  | { type: "menu" }
  | { type: "nonce" }
  | { type: "action"; action: TrayAction }
  | { type: "open-link"; url: string }
  | { type: "close-window" }
  | { type: "appearance"; appearance: DesktopAppearance };

/**
 * Any frame in the window can post to the app, the agents' canvas pages included; only the page the app handed the
 * nonce to can make it act, and the canvas frames, from another origin, never see it.
 */
export function pageRequest(detail: unknown, nonce: string): PageRequest | null {
  if (typeof detail !== "object" || detail === null) return null;
  const message = detail as Record<string, unknown>;
  if (message.type === "desktop-menu-request") return { type: "menu" };
  if (message.type === "desktop-nonce-request") return { type: "nonce" };
  if (message.nonce !== nonce) return null;
  if (message.type === "desktop-action" && isTrayAction(message.action)) return { type: "action", action: message.action };
  if (message.type === "desktop-close-window") return { type: "close-window" };
  if (message.type === "desktop-appearance" && isDesktopAppearance(message.appearance)) return { type: "appearance", appearance: message.appearance };
  const url = message.type === "desktop-open-link" ? webUrl(message.url) : null;
  return url ? { type: "open-link", url } : null;
}
