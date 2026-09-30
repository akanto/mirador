import { useEffect, useRef } from "react";
import { isCanvasFrameMessage } from "../shared/canvas-document.ts";
import { commandFor, typingStateOf, type ShortcutCommand } from "./shortcuts.ts";

/**
 * Keys pressed inside a canvas page never reach this window (the page is a sandboxed frame),
 * so the page forwards modifier combinations; only the frame that has focus is listened to.
 */
export function useShortcuts(onCommand: (command: ShortcutCommand, fromCanvas: boolean) => void) {
  const latest = useRef(onCommand);
  latest.current = onCommand;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = commandFor(event, typingStateOf(document.activeElement));
      if (!command) return;
      event.preventDefault();
      latest.current(command, false);
    };
    const onFrameMessage = (event: MessageEvent) => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLIFrameElement) || event.source !== focused.contentWindow) return;
      if (!isCanvasFrameMessage(event.data) || event.data.kind !== "key") return;
      const command = commandFor(event.data, event.data.typing ? "typing" : "not-typing");
      if (command) latest.current(command, true);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("message", onFrameMessage);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("message", onFrameMessage);
    };
  }, []);
}
