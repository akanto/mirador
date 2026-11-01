export const LANGUAGES = ["en", "hu"] as const;

export type Language = (typeof LANGUAGES)[number];

/** Each language by its own name, as a language picker lists them. */
export const languageNames: Record<Language, string> = { en: "English", hu: "Magyar" };

export const isLanguage = (value: unknown): value is Language => typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
