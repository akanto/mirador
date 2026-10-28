/** The colours a workspace's mark takes by its name, whatever its pastel, so the mark stands out on the card's tint. */
const workspaceMarkColors = ["#6e56cf", "#0e9384", "#d9822b", "#3e63dd", "#d6409f", "#12a594", "#8e4ec6", "#ad7f58"];

export function workspaceMarkColor(name: string) {
  const hash = [...name].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 7);
  return workspaceMarkColors[hash % workspaceMarkColors.length]!;
}

/** The first letters of two words, or the first two of one. */
export function workspaceInitials(name: string) {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials = words.length > 1 ? words.slice(0, 2).map((word) => word.charAt(0)).join("") : name.slice(0, 2);
  return initials.toUpperCase();
}

/** The first letters of up to two words. */
export const machineInitials = (name: string) =>
  name
    .split(/[\s.\-_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
