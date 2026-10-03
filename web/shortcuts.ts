export type ShortcutCommand =
  | { type: "palette" }
  | { type: "help" }
  | { type: "adjacent-conversation"; step: 1 | -1 }
  | { type: "adjacent-workspace"; step: 1 | -1 }
  | { type: "numbered-conversation"; number: number }
  | { type: "new-conversation" }
  | { type: "new-workspace" }
  | { type: "toggle-canvas" }
  | { type: "find" }
  | { type: "focus"; pane: "chat" | "canvas" }
  | { type: "reload-page" }
  | { type: "restart-host" };

export interface KeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Where the keyboard focus is: text-editing keys must keep working while the user types, and on macOS a terminal keeps ⌘K to clear itself. */
export type TypingState = "not-typing" | "empty-field" | "typing" | "terminal";

export const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/**
 * Bindings chosen so that neither Chrome nor cmux (when the app runs in a cmux browser pane)
 * takes them first. Option+letter bindings avoid macOS dead keys (Option+E/I/N/U/`).
 */
export function commandFor(press: KeyPress, typing: TypingState, mac = isMac): ShortcutCommand | null {
  const primary = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  const optionOnly = press.altKey && !press.metaKey && !press.ctrlKey;

  const terminalClears = mac && typing === "terminal";
  const terminalSearchesHistory = !mac && typing === "terminal";
  if (primary && !press.altKey && !press.shiftKey && press.code === "KeyK" && !terminalClears) return { type: "palette" };
  if (primary && !press.altKey && press.code === "KeyR" && !terminalSearchesHistory) return press.shiftKey ? { type: "restart-host" } : { type: "reload-page" };
  if (primary && !press.altKey && !press.shiftKey && press.code === "Backslash") return { type: "toggle-canvas" };
  if (primary && !press.altKey && !press.shiftKey && press.code === "KeyF" && typing !== "terminal") return { type: "find" };
  if (primary && !press.altKey && press.shiftKey && typing !== "typing") {
    if (press.code === "ArrowLeft") return { type: "focus", pane: "chat" };
    if (press.code === "ArrowRight") return { type: "focus", pane: "canvas" };
  }
  if (optionOnly) {
    const step = press.code === "ArrowDown" ? 1 : press.code === "ArrowUp" ? -1 : null;
    if (step) return press.shiftKey ? { type: "adjacent-workspace", step } : { type: "adjacent-conversation", step };
    const digit = press.code.match(/^Digit([1-9])$/)?.[1];
    if (digit && !press.shiftKey) return { type: "numbered-conversation", number: Number(digit) };
    if (press.code === "KeyT") return press.shiftKey ? { type: "new-workspace" } : { type: "new-conversation" };
  }
  if (press.key === "?" && !press.metaKey && !press.ctrlKey && !press.altKey && typing === "not-typing") return { type: "help" };
  return null;
}

export function typingStateOf(element: Element | null): TypingState {
  if (element?.closest(".xterm")) return "terminal";
  if (element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && element.type !== "checkbox")) {
    return element.value === "" ? "empty-field" : "typing";
  }
  if (element instanceof HTMLElement && element.isContentEditable) return "typing";
  return "not-typing";
}

export const keyLabels = (mac = isMac) => ({
  primary: mac ? "⌘" : "Ctrl+",
  option: mac ? "⌥" : "Alt+",
  shift: mac ? "⇧" : "Shift+",
});

/** The keys of commands that a button does too; the button's hint shows them. */
export function shortcutKeys(mac = isMac) {
  const { primary, option, shift } = keyLabels(mac);
  return {
    palette: `${primary}K`,
    help: "?",
    newConversation: `${option}T`,
    newWorkspace: `${option}${shift}T`,
    toggleCanvas: `${primary}\\`,
    find: `${primary}F`,
    restartHost: `${primary}${shift}R`,
    send: "Enter",
    sendTheOtherWay: `${option}Enter`,
    stop: "Esc",
  };
}

export function shortcutHelp(mac = isMac): { keys: string; action: string }[] {
  const { primary, option, shift } = keyLabels(mac);
  const keys = shortcutKeys(mac);
  return [
    { keys: keys.palette, action: "Palette: go to a conversation, start one, open a dialog (in a terminal, clears it instead)" },
    { keys: `${option}↑ / ${option}↓`, action: "Previous / next conversation" },
    { keys: `${option}${shift}↑ / ${option}${shift}↓`, action: "Previous / next workspace" },
    { keys: `${option}1 … ${option}9`, action: "Conversation 1–9 in this workspace" },
    { keys: keys.newConversation, action: "New conversation in this workspace (with its profile)" },
    { keys: keys.newWorkspace, action: "Add a workspace (a project directory)" },
    { keys: keys.toggleCanvas, action: "Show / hide the canvas" },
    { keys: keys.find, action: "Find in this conversation, earlier entries and folded cards included (Enter: older match, Shift+Enter: newer)" },
    { keys: `${primary}V`, action: "In the message box, an image on the clipboard goes in as [Image #1] (dropping an image file does too)" },
    { keys: `${primary}${shift}← / ${primary}${shift}→`, action: "Focus the message box / the canvas (not while editing text)" },
    { keys: `${primary}R`, action: "Reload the page, with the UI code as it is now" },
    { keys: keys.restartHost, action: "Restart the host to run its code as it is now; working agents stop and then continue where they left off" },
    { keys: `${keys.send} / ${keys.sendTheOtherWay}`, action: "While the agent works: add the message to its running turn, or send it after the turn ends (Settings picks which key does which)" },
    { keys: "Esc", action: "Close a dialog; in the message box, stop the running turn" },
    { keys: keys.help, action: "This list (outside text fields)" },
  ];
}
