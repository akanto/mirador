import { useState } from "react";

export type Theme = "light" | "dark" | "system";

export const themeLabels: Record<Theme, string> = { light: "Light", dark: "Dark", system: "Match system" };

const STORAGE_KEY = "mirador-theme";

export function storedTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "dark" || saved === "system" ? saved : "light";
  } catch {
    return "light";
  }
}

/** The stylesheet reads the theme from the root element; canvas pages follow it through color-scheme. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setTheme] = useState(storedTheme);
  const choose = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  };
  return [theme, choose] as const;
}
