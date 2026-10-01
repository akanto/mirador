import type { ITheme } from "@xterm/xterm";
import { paletteColor } from "./ansi.ts";

/** Prompts and statusline scripts draw with Nerd Font glyphs; the first of these the Mac has renders them. */
export const TERMINAL_FONT = '"MesloLGS NF", "Symbols Nerd Font Mono", "JetBrainsMono Nerd Font", "Hack Nerd Font", Menlo, monospace';
export const TERMINAL_BACKGROUND = "#1b1c22";
export const TERMINAL_FOREGROUND = "#d4d6de";

const ansiNames = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const capitalized = (name: string) => name[0]!.toUpperCase() + name.slice(1);

/** The same dark look and colours the statusline uses, in both app themes. */
export const terminalTheme: ITheme = {
  background: TERMINAL_BACKGROUND,
  foreground: TERMINAL_FOREGROUND,
  cursor: TERMINAL_FOREGROUND,
  selectionBackground: "rgb(124 196 255 / 0.3)",
  ...Object.fromEntries(ansiNames.flatMap((name, index) => [[name, paletteColor(index)], [`bright${capitalized(name)}`, paletteColor(index + 8)]])),
};
