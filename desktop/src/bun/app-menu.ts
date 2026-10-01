import { ApplicationMenu } from "electrobun/main";

export function installApplicationMenu(appName: string) {
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
      submenu: [{ role: "minimize", accelerator: "m" }, { role: "zoom" }, { role: "close", accelerator: "w" }, { role: "bringAllToFront" }],
    },
  ]);
}
