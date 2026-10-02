import { isMac, type KeyPress } from "./shortcuts.ts";

export type TerminalKeyAction = { type: "clear" } | { type: "copy" } | { type: "browser-paste" } | { type: "send"; data: string };

const send = (data: string): TerminalKeyAction => ({ type: "send", data });

const withCommand: Record<string, TerminalKeyAction> = {
  KeyK: { type: "clear" },
  ArrowLeft: send("\x01"),
  ArrowRight: send("\x05"),
  Backspace: send("\x15"),
};

const withOption: Record<string, TerminalKeyAction> = {
  ArrowLeft: send("\x1bb"),
  ArrowRight: send("\x1bf"),
};

const withControlShift: Record<string, TerminalKeyAction> = {
  KeyC: { type: "copy" },
  KeyV: { type: "browser-paste" },
};

/**
 * Elsewhere, Ctrl+Shift+C copies the selection and Ctrl+Shift+V pastes, as in GNOME Terminal, Konsole and VS Code, while
 * Ctrl+C and Ctrl+V stay ^C and ^V for the shell. The paste is the browser's own, which xterm.js receives as a paste event.
 */
function linuxTerminalKeyAction(press: KeyPress): TerminalKeyAction | null {
  if (!press.ctrlKey || !press.shiftKey || press.altKey || press.metaKey) return null;
  return withControlShift[press.code] ?? null;
}

/**
 * The macOS terminal keys xterm.js leaves out, as Terminal.app, iTerm2 and VS Code have them: ⌘K clears, ⌘←/⌘→ go to
 * the start/end of the line (^A/^E), ⌘⌫ deletes to its start (^U), ⌥←/⌥→ move by word (Esc b/Esc f, as readline and
 * zsh bind them; xterm.js would send Esc[1;3D, which they don't).
 */
export function terminalKeyAction(press: KeyPress, mac = isMac): TerminalKeyAction | null {
  if (!mac) return linuxTerminalKeyAction(press);
  if (press.ctrlKey || press.shiftKey) return null;
  if (press.metaKey && !press.altKey) return withCommand[press.code] ?? null;
  if (press.altKey && !press.metaKey) return withOption[press.code] ?? null;
  return null;
}
