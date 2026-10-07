/** A folder name still being typed: the completions extend it, and it does not name a folder yet. */
function typingAName(path: string, completions: string[]) {
  return !path.endsWith("/") && !completions.includes(`${path}/`) && completions.some((completion) => completion.startsWith(path));
}

/**
 * The completion Enter takes: the one picked with the arrow keys, else the first while a name is being typed.
 * Null when Enter adds the path as typed.
 */
export function highlightedCompletion(path: string, completions: string[], picked: number | null): number | null {
  if (picked !== null && picked < completions.length) return picked;
  return typingAName(path, completions) ? 0 : null;
}
