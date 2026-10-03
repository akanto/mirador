import { contentText, type TimelineBlock, type ToolBlock } from "./timeline.ts";

export const MIN_SEARCH_LENGTH = 2;

const escapedForRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const patternFor = (query: string) => new RegExp(escapedForRegExp(query), "gi");

/** Where the query occurs in the text, ignoring case: [start, end) offsets of each occurrence, in order. */
export function matchOffsets(text: string, query: string): [number, number][] {
  if (query === "") return [];
  return [...text.matchAll(patternFor(query))].map((match) => [match.index, match.index + match[0].length]);
}

/** How often the query occurs in the text, ignoring case; a one-letter query can occur millions of times, so none is kept. */
export function matchCount(text: string, query: string) {
  if (query === "") return 0;
  const pattern = patternFor(query);
  let count = 0;
  while (pattern.exec(text)) count++;
  return count;
}

const rawText = (raw: unknown) => (raw === undefined || raw === null ? [] : [typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)]);

function toolTexts(block: ToolBlock): string[] {
  return [
    block.title,
    ...block.locations.map(({ path }) => path),
    ...block.content.flatMap((content) => {
      if (content.type === "content") return [contentText(content.content)];
      if (content.type === "diff") return [content.path, content.oldText ?? "", content.newText];
      return [];
    }),
    ...rawText(block.rawInput),
    ...rawText(block.rawOutput),
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
export const occurrencesIn = (block: TimelineBlock, query: string) => matchCount(textsOf(block).join("\n"), query);
