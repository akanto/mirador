import { ApplicationMenu } from "electrobun/main";

const CLOSE = "close";

/** ⌘W reaches here when the page did not take it, or before the page saw it: the page decides what it closes. */
export function installApplicationMenu(appName: string, closeWhatHasFocus: () => void) {
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
      submenu: [{ role: "minimize", accelerator: "m" }, { role: "zoom" }, { label: "Close", action: CLOSE, accelerator: "w" }, { role: "bringAllToFront" }],
    },
  ]);
  ApplicationMenu.on("application-menu-clicked", (event) => {
    if ((event as { data?: { action?: unknown } }).data?.action === CLOSE) closeWhatHasFocus();
  });
}
