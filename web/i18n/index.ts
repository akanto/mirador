import type { Language } from "../../shared/i18n/languages.ts";
import { language } from "../language.ts";
import { en, type Messages } from "./en/index.ts";
import { hu } from "./hu/index.ts";

const messages: Record<Language, Messages> = { en, hu };

export const t = messages[language];

export const formatNumber = (value: number) => value.toLocaleString(language);
