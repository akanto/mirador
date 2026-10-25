import { fenced } from "./fenced.ts";

/** An element of a canvas page, as the page describes it: where it sits and its HTML, cut short. */
export interface MarkedElement {
  /** A CSS selector from the body down to it, such as `main > table > tr:nth-of-type(2) > td.pro`. */
  path: string;
  html: string;
}

/** What the user pointed at on a canvas page: text they selected, in the element that holds it, or an element they picked. */
export type PageMark = { kind: "text"; text: string; element: MarkedElement } | { kind: "element"; element: MarkedElement };

/** Ask wants an answer in the chat; Change wants the page shown again with the change made. */
export type MarkIntent = "ask" | "change";

export const MAX_MARKED_TEXT = 4000;
export const MAX_MARKED_HTML = 1200;
export const MAX_MARKED_PATH = 300;

const LABEL_CHARACTERS = 60;

const CHANGE_REQUEST = "Show the page again with this changed, under the same title, and leave the rest of it as it is.";

const clipped = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

const quoted = (text: string) => text.split("\n").map((line) => `> ${line}`).join("\n");

function elementFrom(value: unknown): MarkedElement | null {
  if (typeof value !== "object" || value === null) return null;
  const { path, html } = value as Partial<MarkedElement>;
  if (typeof path !== "string" || typeof html !== "string" || !path) return null;
  return { path: clipped(path, MAX_MARKED_PATH), html: clipped(html, MAX_MARKED_HTML) };
}

/** The mark a page reported, or null when what it posted is not one. */
export function pageMarkFrom(value: unknown): PageMark | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, text } = value as { kind?: unknown; text?: unknown };
  const element = elementFrom((value as { element?: unknown }).element);
  if (!element) return null;
  if (kind === "element") return { kind, element };
  if (kind === "text" && typeof text === "string" && text.trim()) return { kind, text: clipped(text.trim(), MAX_MARKED_TEXT), element };
  return null;
}

const lastStep = (path: string) => path.split(" > ").pop() ?? path;

/** A few words for what was marked, for the box that asks about it. */
export function pageMarkLabel(mark: PageMark) {
  if (mark.kind === "text") return `“${clipped(mark.text.replace(/\s+/g, " "), LABEL_CHARACTERS)}”`;
  return `the element ${lastStep(mark.element.path)}`;
}

function markedPart(pageTitle: string, mark: PageMark) {
  const html = fenced(mark.element.html, "html");
  if (mark.kind === "text") return `About this text on the canvas page "${pageTitle}":\n\n${quoted(mark.text)}\n\nIt is in \`${mark.element.path}\`:\n\n${html}`;
  return `About this element on the canvas page "${pageTitle}", at \`${mark.element.path}\`:\n\n${html}`;
}

/** The user's message about what they marked on a page: it names the page and quotes the mark, so the agent need not guess which part is meant. */
export function pageMarkPrompt(pageTitle: string, mark: PageMark, words: string, intent: MarkIntent) {
  const asked = `${markedPart(pageTitle, mark)}\n\n${words.trim()}`;
  return intent === "change" ? `${asked}\n\n${CHANGE_REQUEST}` : asked;
}
