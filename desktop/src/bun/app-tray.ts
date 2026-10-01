import { Tray } from "electrobun/main";
import { trayMenu, type TrayAction, type TrayState } from "../core/tray-menu.ts";

const trayActions: readonly string[] = ["open", "restart-host", "toggle-background", "toggle-open-at-login", "quit"] satisfies TrayAction[];
const isTrayAction = (action: unknown): action is TrayAction => typeof action === "string" && trayActions.includes(action);

export class AppTray {
  private readonly tray = new Tray({ title: "VS" });

  constructor(onAction: (action: TrayAction) => void) {
    this.tray.on("tray-clicked", (event) => {
      const action = (event as { data?: { action?: unknown } }).data?.action;
      if (isTrayAction(action)) onAction(action);
    });
  }

  render(state: TrayState) {
    this.tray.setMenu(trayMenu(state));
  }
}
