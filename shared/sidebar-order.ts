/** Where the user put things in the sidebar; equal positions keep the order the things were made in. */
export const inSidebarOrder = (a: { position: number; createdAt: number }, b: { position: number; createdAt: number }) =>
  a.position - b.position || a.createdAt - b.createdAt;

/** The ids with one of them moved to just before another, or to the end; unchanged when either is not among them. */
export function movedBefore(ids: string[], id: string, beforeId: string | null): string[] {
  if (!ids.includes(id)) return ids;
  const others = ids.filter((each) => each !== id);
  const at = beforeId === null ? others.length : others.indexOf(beforeId);
  return at < 0 ? ids : [...others.slice(0, at), id, ...others.slice(at)];
}
