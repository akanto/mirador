import { contentText, type TimelineBlock, type ToolBlock } from "./timeline.ts";

export const MIN_SEARCH_LENGTH = 2;

const escapedForRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Finding ignores case unless the find bar's Match case is on. */
export interface MatchOptions {
  caseSensitive: boolean;
}

export const ignoringCase: MatchOptions = { caseSensitive: false };

const patternFor = (query: string, { caseSensitive }: MatchOptions) => new RegExp(escapedForRegExp(query), caseSensitive ? "g" : "gi");

/** Where the query occurs in the text: [start, end) offsets of each occurrence, in order. */
export function matchOffsets(text: string, query: string, options = ignoringCase): [number, number][] {
  if (query === "") return [];
  return [...text.matchAll(patternFor(query, options))].map((match) => [match.index, match.index + match[0].length]);
}

/** How often the query occurs in the text; a one-letter query can occur millions of times, so none is kept. */
export function matchCount(text: string, query: string, options = ignoringCase) {
  if (query === "") return 0;
  const pattern = patternFor(query, options);
  let count = 0;
  while (pattern.exec(text)) count++;
  return count;
}

/** The words and numbers in a tool call's input or output, without the JSON around them. */
function wordsIn(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  if (typeof raw === "number") return [String(raw)];
  if (Array.isArray(raw)) return raw.flatMap(wordsIn);
  return typeof raw === "object" && raw !== null ? Object.values(raw).flatMap(wordsIn) : [];
}

function toolTexts(block: ToolBlock): string[] {
  return [
    block.title,
    ...block.locations.map(({ path }) => path),
    ...block.content.flatMap((content) => {
      if (content.type === "content") return [contentText(content.content)];
      if (content.type === "diff") return [content.path, content.oldText ?? "", content.newText];
      return [];
    }),
    ...wordsIn(block.rawInput),
    ...wordsIn(block.rawOutput),
    ...(block.subagent?.blocks.flatMap(textsOf) ?? []),
  ];
}

/** The text an entry shows, also what it shows only once unfolded, as stored rather than as rendered. */
export function textsOf(block: TimelineBlock): string[] {
  switch (block.kind) {
    case "user":
    case "agent":
    case "thought":
    case "notice":
    case "info":
      return [block.text];
    case "error":
      return [block.message];
    case "plan":
      return block.entries.map(({ content }) => content);
    case "command":
      return [block.command.command, ...block.command.chunks.map(({ text }) => text)];
    case "permission":
      return [block.toolCall.title ?? "", ...block.options.map(({ name }) => name)];
    case "tool":
      return toolTexts(block);
  }
}

/** How often an entry not in the page holds the query; once in the page, its rendered text counts instead. */
export const occurrencesIn = (block: TimelineBlock, query: string, options = ignoringCase) => matchCount(textsOf(block).join("\n"), query, options);
