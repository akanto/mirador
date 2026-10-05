import { useSyncExternalStore } from "react";

export const TERMINAL_FONT_SIZES = Array.from({ length: 14 }, (_, index) => 11 + index);

const DEFAULT_TERMINAL_FONT_SIZE = 12;

const clampFontSize = (size: number) => Math.min(24, Math.max(11, size));

export const storedTerminalFontSize = (): number => {
  try {
    const saved = Number(localStorage.getItem("mirador-terminal-font-size"));
    return TERMINAL_FONT_SIZES.includes(saved) ? saved : DEFAULT_TERMINAL_FONT_SIZE;
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
};

let currentFontSize = storedTerminalFontSize();
const fontListeners = new Set<() => void>();

/** xterm keeps its own grid; every terminal follows the size at once and re-fits. */
export function setTerminalFontSize(size: number) {
  currentFontSize = clampFontSize(size);
  try {
    localStorage.setItem("mirador-terminal-font-size", String(currentFontSize));
  } catch {}
  fontListeners.forEach((listener) => listener());
}

/** One px up or down, in single-pixel steps; the ends stay put. */
export const stepTerminalFontSize = (direction: 1 | -1) => setTerminalFontSize(currentFontSize + direction);

export const terminalFontSize = () => currentFontSize;

export const resetTerminalFontSize = () => setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);

export function subscribeTerminalFontSize(listener: () => void) {
  fontListeners.add(listener);
  return () => void fontListeners.delete(listener);
}

export function useTerminalFontSize() {
  const size = useSyncExternalStore(subscribeTerminalFontSize, () => currentFontSize);
  return [size, setTerminalFontSize] as const;
}
