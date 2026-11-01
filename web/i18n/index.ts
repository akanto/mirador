import type { Language } from "../../shared/i18n/languages.ts";
import { language } from "../language.ts";
import { en, type Messages } from "./en/index.ts";
import { es } from "./es/index.ts";
import { hu } from "./hu/index.ts";

const messages: Record<Language, Messages> = { en, hu, es };

export const t = messages[language];

/** The browser's own locale when it is in the chosen language, so its region's dates stay; otherwise the language. */
export const locale = typeof navigator !== "undefined" && navigator.language?.split("-")[0] === language ? navigator.language : language;

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions) => value.toLocaleString(locale, options);
