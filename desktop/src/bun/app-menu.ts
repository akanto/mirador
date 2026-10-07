import { ApplicationMenu } from "electrobun/main";

const CLOSE_WINDOW = "close-window";

/** ⌘W is easily pressed meaning something inside Mirador, so it asks before the window closes. */
export function installApplicationMenu(appName: string, closeWindowAfterAsking: () => void) {
  ApplicationMenu.setApplicationMenu([
    {
      label: appName,
      submenu: [
        { role: "hide", accelerator: "h" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "separator" },
        { role: "quit", accelerator: "q" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize", accelerator: "m" }, { role: "zoom" }, { label: "Close Window", action: CLOSE_WINDOW, accelerator: "w" }, { role: "bringAllToFront" }],
    },
  ]);
  ApplicationMenu.on("application-menu-clicked", (event) => {
    if ((event as { data?: { action?: unknown } }).data?.action === CLOSE_WINDOW) closeWindowAfterAsking();
  });
}
