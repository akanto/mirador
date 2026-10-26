import type { Conversation, Workspace } from "./model.ts";
import type { SidebarItem } from "./sidebar-order.ts";

const normalized = (text: string) => text.toLocaleLowerCase();

export const filterWords = (query: string) => normalized(query).split(/\s+/).filter(Boolean);

/** Every word occurs somewhere in the texts, in any order, ignoring case. */
const matchesAll = (words: string[], texts: string[]) => {
  const haystack = normalized(texts.join("\n"));
  return words.every((word) => haystack.includes(word));
};

export interface FilteredSidebar {
  items: SidebarItem[];
  /** The conversations to list under each workspace kept, by its id. */
  conversationsOf: Map<string, Conversation[]>;
}

/**
 * The sidebar narrowed to what the query names. The words may fall anywhere in a conversation's title or in the names of
 * its workspace and group, so "mirador queue" finds the queue conversation in mirador. A
 * workspace or group the words name on its own keeps everything in it.
 */
export function filterSidebar(items: SidebarItem[], conversationsIn: (workspaceId: string) => Conversation[], query: string): FilteredSidebar {
  const words = filterWords(query);
  const conversationsOf = new Map<string, Conversation[]>();
  const keeps = (workspace: Workspace, groupName: string) => {
    const place = [groupName, workspace.name];
    const conversations = conversationsIn(workspace.id);
    const placeMatches = matchesAll(words, place);
    const shown = placeMatches ? conversations : conversations.filter(({ title }) => matchesAll(words, [...place, title]));
    if (!placeMatches && shown.length === 0) return false;
    conversationsOf.set(workspace.id, shown);
    return true;
  };
  const kept = items.flatMap((item): SidebarItem[] => {
    if (item.kind === "workspace") return keeps(item.workspace, "") ? [item] : [];
    const workspaces = item.workspaces.filter((workspace) => keeps(workspace, item.group.name));
    return workspaces.length > 0 || matchesAll(words, [item.group.name]) ? [{ ...item, workspaces }] : [];
  });
  return { items: kept, conversationsOf };
}
