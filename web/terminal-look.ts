import type { ITheme } from "@xterm/xterm";
import { paletteColor } from "./ansi.ts";

/** Prompts and statusline scripts draw with Nerd Font glyphs; the first of these the Mac has renders them. */
export const TERMINAL_FONT = '"MesloLGS NF", "Symbols Nerd Font Mono", "JetBrainsMono Nerd Font", "Hack Nerd Font", Menlo, monospace';
export const TERMINAL_BACKGROUND = "#1b1c22";
export const TERMINAL_FOREGROUND = "#d4d6de";

/**
 * The statusline strip follows the app theme. Scripts colour themselves for dark terminals, so on the light strip a
 * colour drawn straight on it is darkened until it reads; one on a background of its own stays as the script drew it.
 */
export const statuslineLooks = {
  dark: { background: TERMINAL_BACKGROUND, foreground: TERMINAL_FOREGROUND, minimumContrast: 1 },
  light: { background: "#f3f4f6", foreground: "#24262d", minimumContrast: 4.5 },
} as const;

export type StatuslineLook = (typeof statuslineLooks)[keyof typeof statuslineLooks];

const boxDrawingAndBlocks = /[\u2500-\u259f]/u;
const powerlineGlyphs = /[\ue0a0-\ue0d7]/u;

/** Powerline caps and box drawing take the colour of the block they join, so, as in xterm.js, no minimum contrast applies to them. */
export const drawsShapesOnly = (text: string) =>
  [...text].every((character) => /\s/u.test(character) || boxDrawingAndBlocks.test(character) || powerlineGlyphs.test(character));

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
