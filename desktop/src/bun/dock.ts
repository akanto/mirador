import { Utils } from "electrobun/main";

/** Only macOS has a Dock. */
export function setDockIconVisible(visible: boolean) {
  if (process.platform === "darwin") Utils.setDockIconVisible(visible);
}
