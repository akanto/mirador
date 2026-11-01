import { isLanguage, type Language } from "../shared/i18n/languages.ts";

const STORAGE_KEY = "mirador-language";

export function storedLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isLanguage(saved) ? saved : "en";
  } catch {
    return "en";
  }
}

/** Read once as the page loads: every text of the page is picked in it, so choosing another one reloads the page. */
export const language = storedLanguage();

export function chooseLanguage(next: Language) {
  if (next === language) return;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {}
  location.reload();
}

export const applyLanguage = () => {
  document.documentElement.lang = language;
};
