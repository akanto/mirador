export type ShortcutCommand =
  | { type: "palette" }
  | { type: "help" }
  | { type: "adjacent-conversation"; step: 1 | -1 }
  | { type: "adjacent-workspace"; step: 1 | -1 }
  | { type: "numbered-conversation"; number: number }
  | { type: "new-conversation" }
  | { type: "toggle-canvas" }
  | { type: "focus"; pane: "chat" | "canvas" };

export interface KeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Where the keyboard focus is: text-editing keys must keep working while the user types. */
export type TypingState = "not-typing" | "empty-field" | "typing";

export const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/**
 * Bindings chosen so that neither Chrome nor cmux (when the app runs in a cmux browser pane)
 * takes them first. Option+letter bindings avoid macOS dead keys (Option+E/I/N/U/`).
 */
export function commandFor(press: KeyPress, typing: TypingState, mac = isMac): ShortcutCommand | null {
  const primary = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  const optionOnly = press.altKey && !press.metaKey && !press.ctrlKey;

  if (primary && !press.altKey && !press.shiftKey && press.code === "KeyK") return { type: "palette" };
  if (primary && !press.altKey && !press.shiftKey && press.code === "Backslash") return { type: "toggle-canvas" };
  if (primary && !press.altKey && press.shiftKey && typing !== "typing") {
    if (press.code === "ArrowLeft") return { type: "focus", pane: "chat" };
    if (press.code === "ArrowRight") return { type: "focus", pane: "canvas" };
  }
  if (optionOnly) {
    const step = press.code === "ArrowDown" ? 1 : press.code === "ArrowUp" ? -1 : null;
    if (step) return press.shiftKey ? { type: "adjacent-workspace", step } : { type: "adjacent-conversation", step };
    const digit = press.code.match(/^Digit([1-9])$/)?.[1];
    if (digit && !press.shiftKey) return { type: "numbered-conversation", number: Number(digit) };
    if (press.code === "KeyT" && !press.shiftKey) return { type: "new-conversation" };
  }
  if (press.key === "?" && !press.metaKey && !press.ctrlKey && !press.altKey && typing === "not-typing") return { type: "help" };
  return null;
}

export function typingStateOf(element: Element | null): TypingState {
  if (element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && element.type !== "checkbox")) {
    return element.value === "" ? "empty-field" : "typing";
  }
  if (element instanceof HTMLElement && element.isContentEditable) return "typing";
  return "not-typing";
}

const keyLabels = (mac: boolean) => ({
  primary: mac ? "⌘" : "Ctrl+",
  option: mac ? "⌥" : "Alt+",
  shift: mac ? "⇧" : "Shift+",
});

export function shortcutHelp(mac = isMac): { keys: string; action: string }[] {
  const { primary, option, shift } = keyLabels(mac);
  return [
    { keys: `${primary}K`, action: "Palette: go to a conversation, start one, open a dialog" },
    { keys: `${option}↑ / ${option}↓`, action: "Previous / next conversation" },
    { keys: `${option}${shift}↑ / ${option}${shift}↓`, action: "Previous / next workspace" },
    { keys: `${option}1 … ${option}9`, action: "Conversation 1–9 in this workspace" },
    { keys: `${option}T`, action: "New conversation in this workspace (with its profile)" },
    { keys: `${primary}\\`, action: "Show / hide the canvas" },
    { keys: `${primary}${shift}← / ${primary}${shift}→`, action: "Focus the message box / the canvas (not while editing text)" },
    { keys: "Esc", action: "Close a dialog; in the message box, stop the running turn" },
    { keys: "?", action: "This list (outside text fields)" },
  ];
}
