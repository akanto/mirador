/**
 * Slack's set of markdown, as a message is written: bold, italic, strikethrough, inline code, code blocks, quotes, lists
 * and links. Everything else, such as `# heading`, a table or `<div>`, is text kept as typed.
 *
 * A message is lines. What was typed is kept byte for byte, so the text the agent receives is the text the person wrote;
 * formatting only reads markers already there. `markdownOf(parseMessage(text))` is always `text`: where the blocks
 * read couldn't give the same text back, the message reads as plain lines instead.
 */

export type Mark = "bold" | "italic" | "strike" | "code";

export type Inline = { kind: "text"; text: string; marks: Mark[] } | { kind: "link"; url: string; text: string } | { kind: "break" };

export type Block =
  | { kind: "lines"; inlines: Inline[] }
  | { kind: "code"; language: string; code: string }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] };

/** Markers in the order they nest, outermost first, each in the one spelling the message is written in. */
const MARKERS: [Exclude<Mark, "code">, string][] = [
  ["bold", "**"],
  ["italic", "*"],
  ["strike", "~~"],
];

/**
 * A pair formats only where Slack's would: opening at the start, after a space or an opening bracket, and closing before
 * the end, a space or punctuation, with no space just inside either marker. So `2 * 3 * 4`, `src/**\/*.ts` and
 * `some_var_name` stay as typed.
 */
const OPENS = String.raw`(?<=^|[\s(])`;
const CLOSES = String.raw`(?=$|[\s).,:;!?'"])`;
const paired = (marker: string, inner: string) => `${OPENS}${marker}(?!\\s)(${inner})(?<!\\s)${marker}${CLOSES}`;
const INLINE = new RegExp(
  [
    "`([^`\\n]+)`",
    String.raw`\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)`,
    paired(String.raw`\*\*`, String.raw`[^*\n]+?`),
    paired("~~", String.raw`[^~\n]+?`),
    paired(String.raw`\*`, String.raw`[^*\n]+?`),
  ].join("|"),
  "g",
);

export function inlinesOfLine(line: string): Inline[] {
  const inlines: Inline[] = [];
  let last = 0;
  const text = (from: number, to: number) => {
    if (to > from) inlines.push({ kind: "text", text: line.slice(from, to), marks: [] });
  };
  for (const match of line.matchAll(INLINE)) {
    const [whole, code, linkText, url, bold, strike, italic] = match;
    text(last, match.index);
    if (code !== undefined) inlines.push({ kind: "text", text: code, marks: ["code"] });
    else if (url !== undefined) inlines.push({ kind: "link", url, text: linkText! });
    else if (bold !== undefined) inlines.push({ kind: "text", text: bold, marks: ["bold"] });
    else if (strike !== undefined) inlines.push({ kind: "text", text: strike, marks: ["strike"] });
    else inlines.push({ kind: "text", text: italic!, marks: ["italic"] });
    last = match.index + whole.length;
  }
  text(last, line.length);
  return inlines;
}

const linesOf = (lines: string[], read: (line: string) => Inline[]): Inline[] =>
  lines.flatMap((line, index) => (index === 0 ? read(line) : [{ kind: "break" } as const, ...read(line)]));

const asTyped = (line: string): Inline[] => (line ? [{ kind: "text", text: line, marks: [] }] : []);

const FENCE_OPENS = /^```([\w+#-]*)$/;
const FENCE_CLOSES = "```";
const QUOTE = /^> /;
const BULLET = /^- (?=\S)/;
const NUMBERED = /^\d+\. (?=\S)/;

type LineKind = "quote" | "bullet" | "numbered";
const PATTERNS: Record<LineKind, RegExp> = { quote: QUOTE, bullet: BULLET, numbered: NUMBERED };
const kindOf = (line: string) => (Object.keys(PATTERNS) as LineKind[]).find((kind) => PATTERNS[kind].test(line));

function blockOfRun(kind: LineKind, run: string[]): Block {
  if (kind === "quote") return { kind: "quote", inlines: linesOf(run.map((line) => line.replace(QUOTE, "")), inlinesOfLine) };
  return { kind: "list", ordered: kind === "numbered", items: run.map((line) => inlinesOfLine(line.replace(PATTERNS[kind], ""))) };
}

function blocksOf(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let prose: string[] = [];
  const endProse = () => {
    if (prose.length) blocks.push({ kind: "lines", inlines: linesOf(prose, inlinesOfLine) });
    prose = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = FENCE_OPENS.exec(line);
    const closing = fence ? lines.indexOf(FENCE_CLOSES, index + 1) : -1;
    if (fence && closing > index) {
      endProse();
      blocks.push({ kind: "code", language: fence[1]!, code: lines.slice(index + 1, closing).join("\n") });
      index = closing + 1;
      continue;
    }
    const kind = kindOf(line);
    if (!kind) {
      prose.push(line);
      index++;
      continue;
    }
    endProse();
    const run: string[] = [];
    while (index < lines.length && PATTERNS[kind].test(lines[index]!)) run.push(lines[index++]!);
    blocks.push(blockOfRun(kind, run));
  }
  endProse();
  return blocks;
}

/** The message as plain lines, nothing formatted. */
export const plainMessage = (text: string): Block[] => [{ kind: "lines", inlines: linesOf(text.split("\n"), asTyped) }];

export function parseMessage(text: string): Block[] {
  const blocks = blocksOf(text);
  return markdownOf(blocks) === text ? blocks : plainMessage(text);
}

/** A slash command or a shell line is shown as plain lines: it is run as typed, so it must read as typed. */
export const blocksOfMessage = (text: string): Block[] => (/^\s*[/!]/.test(text) ? plainMessage(text) : parseMessage(text));

function markdownOfInlines(inlines: Inline[]): string {
  return inlines
    .map((inline) => {
      if (inline.kind === "break") return "\n";
      if (inline.kind === "link") return `[${inline.text}](${inline.url})`;
      if (inline.marks.includes("code")) return `\`${inline.text}\``;
      const markers = MARKERS.filter(([mark]) => inline.marks.includes(mark)).map(([, marker]) => marker);
      return markers.join("") + inline.text + markers.toReversed().join("");
    })
    .join("");
}

function markdownOfBlock(block: Block): string {
  switch (block.kind) {
    case "lines":
      return markdownOfInlines(block.inlines);
    case "code":
      return `\`\`\`${block.language}\n${block.code}\n\`\`\``;
    case "quote":
      return markdownOfInlines(block.inlines)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "list":
      return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${markdownOfInlines(item)}`).join("\n");
  }
}

/** The blocks as the text they were read from, or as the box writes what was formatted in it. */
export function markdownOf(blocks: Block[]): string {
  return blocks.map(markdownOfBlock).join("\n");
}
