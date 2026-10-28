/** A run of a line's characters, from `start` up to `end`. */
export interface TextRange {
  start: number;
  end: number;
}

const MAX_TOKEN_CELLS = 250_000;
/** Below this share of the two lines' characters kept, the line was rewritten rather than edited, and marking words only adds noise. */
const MIN_KEPT_SHARE = 0.4;

const tokensOf = (line: string) => line.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];

/** Which tokens of each line are in a longest common subsequence of the two. */
function keptTokens(before: string[], after: string[]) {
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const keptBefore = before.map(() => false);
  const keptAfter = after.map(() => false);
  let [i, j] = [0, 0];
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      keptBefore[i++] = true;
      keptAfter[j++] = true;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return { keptBefore, keptAfter };
}

/** The ranges of tokens not kept, with the whitespace between two of them taken in, so a changed phrase reads as one. */
function changedRanges(line: string, tokens: string[], kept: boolean[]): TextRange[] {
  const ranges: TextRange[] = [];
  let offset = 0;
  tokens.forEach((token, index) => {
    const end = offset + token.length;
    if (!kept[index]) {
      const last = ranges.at(-1);
      if (last && /^\s*$/.test(line.slice(last.end, offset))) last.end = end;
      else ranges.push({ start: offset, end });
    }
    offset = end;
  });
  return ranges;
}

const keptLength = (tokens: string[], kept: boolean[]) => tokens.reduce((sum, token, index) => sum + (kept[index] && /\S/.test(token) ? token.length : 0), 0);
const visibleLength = (tokens: string[]) => tokens.reduce((sum, token) => sum + (/\S/.test(token) ? token.length : 0), 0);

/**
 * What changed between a removed line and the added line that replaces it, as ranges of each; null when the two have
 * too little in common for the ranges to help, or are too long to compare.
 */
export function wordChanges(before: string, after: string): { removed: TextRange[]; added: TextRange[] } | null {
  const [beforeTokens, afterTokens] = [tokensOf(before), tokensOf(after)];
  if (beforeTokens.length * afterTokens.length > MAX_TOKEN_CELLS) return null;
  const { keptBefore, keptAfter } = keptTokens(beforeTokens, afterTokens);
  const kept = keptLength(beforeTokens, keptBefore);
  if (2 * kept < MIN_KEPT_SHARE * (visibleLength(beforeTokens) + visibleLength(afterTokens))) return null;
  return { removed: changedRanges(before, beforeTokens, keptBefore), added: changedRanges(after, afterTokens, keptAfter) };
}

/**
 * The changed words of each row of a diff, or null for a row they are not marked on. Each run of removed rows faces
 * the run of added rows right after it, line by line, as a split diff lays them out.
 */
export function rowWordChanges(rows: { kind: string; text: string }[]): (TextRange[] | null)[] {
  const changes: (TextRange[] | null)[] = rows.map(() => null);
  let removed: number[] = [];
  let added: number[] = [];
  const faceRuns = () => {
    removed.slice(0, added.length).forEach((left, line) => {
      const right = added[line]!;
      const ranges = wordChanges(rows[left]!.text, rows[right]!.text);
      if (ranges) [changes[left], changes[right]] = [ranges.removed, ranges.added];
    });
    [removed, added] = [[], []];
  };
  rows.forEach((row, index) => {
    if (row.kind === "removed" && added.length > 0) faceRuns();
    if (row.kind === "removed") removed.push(index);
    else if (row.kind === "added") added.push(index);
    else faceRuns();
  });
  faceRuns();
  return changes;
}

/** Cuts a line's pieces where the changed ranges start and end, marking the pieces inside them. */
export function markChanged<Piece extends { text: string }>(pieces: Piece[], ranges: TextRange[]): (Piece & { changed: boolean })[] {
  const marked: (Piece & { changed: boolean })[] = [];
  let offset = 0;
  pieces.forEach((piece) => {
    const [start, end] = [offset, offset + piece.text.length];
    const cuts = [start, ...ranges.flatMap((range) => [range.start, range.end]).filter((at) => at > start && at < end), end];
    cuts.slice(1).forEach((cut, index) => {
      const from = cuts[index]!;
      const changed = ranges.some((range) => range.start <= from && from < range.end);
      marked.push({ ...piece, text: piece.text.slice(from - start, cut - start), changed });
    });
    offset = end;
  });
  return marked;
}
