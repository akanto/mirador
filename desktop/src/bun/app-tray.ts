import { Tray } from "electrobun/main";
import { isTrayAction, trayMenu, trayTitle, type TrayAction, type TrayState } from "../core/tray-menu.ts";

/** macOS tints the black template image to suit the menu bar; Linux panels are light or dark, so they get the colour icon. */
const trayIcon =
  process.platform === "darwin"
    ? { image: "views://assets/tray-icon.png", template: true, width: 18, height: 18 }
    : { image: "views://assets/app-icon.png", template: false, width: 22, height: 22 };

export class AppTray {
  private readonly tray = new Tray(trayIcon);
  private shownWaitingCount = 0;

  constructor(onAction: (action: TrayAction) => void) {
    this.tray.on("tray-clicked", (event) => {
      const action = (event as { data?: { action?: unknown } }).data?.action;
      if (isTrayAction(action)) onAction(action);
    });
  }

  showWaitingCount(count: number) {
    if (process.platform !== "darwin" || count === this.shownWaitingCount) return;
    this.shownWaitingCount = count;
    this.tray.setTitle(trayTitle(count));
  }

  render(state: TrayState) {
    this.tray.setMenu(trayMenu(state));
  }
}
