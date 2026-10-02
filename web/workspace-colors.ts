import { useState, type CSSProperties } from "react";
import type { WorkspaceColor } from "../shared/model.ts";

export type WorkspaceColorStyle = "card" | "heading" | "stripe";

export const workspaceColorStyleLabels: Record<WorkspaceColorStyle, string> = {
  card: "Whole card",
  heading: "Heading only",
  stripe: "Stripe and soft tint",
};

const STORAGE_KEY = "mirador-workspace-colors";

export function storedWorkspaceColorStyle(): WorkspaceColorStyle {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "heading" || saved === "stripe" ? saved : "card";
  } catch {
    return "card";
  }
}

/** The stylesheet colours a workspace's card, heading or edge by the root element's data-workspace-colors. */
export function applyWorkspaceColorStyle(style: WorkspaceColorStyle) {
  document.documentElement.dataset.workspaceColors = style;
}

export function useWorkspaceColorStyle() {
  const [style, setStyle] = useState(storedWorkspaceColorStyle);
  const choose = (next: WorkspaceColorStyle) => {
    applyWorkspaceColorStyle(next);
    setStyle(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  };
  return [style, choose] as const;
}

export interface Hsl {
  hue: number;
  saturation: number;
  lightness: number;
}

const pastels: Record<WorkspaceColor, Pick<Hsl, "hue" | "saturation">> = {
  rose: { hue: 350, saturation: 75 },
  peach: { hue: 25, saturation: 85 },
  butter: { hue: 48, saturation: 85 },
  mint: { hue: 145, saturation: 50 },
  teal: { hue: 175, saturation: 45 },
  sky: { hue: 205, saturation: 80 },
  lavender: { hue: 255, saturation: 75 },
  lilac: { hue: 300, saturation: 55 },
};

export const workspaceColors = Object.keys(pastels) as WorkspaceColor[];

/**
 * Text keeps the theme's colour on these: the light theme's dark text on a pale tint, the dark theme's light text on a
 * deep one. The stripe is only a mark, with no text on it.
 */
export function workspaceShades(color: WorkspaceColor) {
  const { hue, saturation } = pastels[color];
  return {
    tint: { light: { hue, saturation, lightness: 90 }, dark: { hue, saturation: 28, lightness: 15 } },
    stripe: { light: { hue, saturation: 60, lightness: 62 }, dark: { hue, saturation: 40, lightness: 45 } },
  };
}

const cssOf = ({ hue, saturation, lightness }: Hsl) => `hsl(${hue} ${saturation}% ${lightness}%)`;
const lightDark = ({ light, dark }: { light: Hsl; dark: Hsl }) => `light-dark(${cssOf(light)}, ${cssOf(dark)})`;

export function workspaceColorVariables(color: WorkspaceColor) {
  const { tint, stripe } = workspaceShades(color);
  return { "--workspace-tint": lightDark(tint), "--workspace-stripe": lightDark(stripe) } as CSSProperties;
}
