/** Who is expected to do an item; anyone may tick it. */
export type ChecklistOwner = "agent" | "user" | "both";

export const checklistOwners: ChecklistOwner[] = ["agent", "user", "both"];

export interface ChecklistItem {
  id: string;
  text: string;
  /** Markdown, shown under the text. */
  detail?: string;
  owner: ChecklistOwner;
  done: boolean;
  /** Whether the item is done as far as the agent knows: it ticked it itself, or has heard that the user did. */
  heardDone: boolean;
}

export interface ChecklistSection {
  title?: string;
  items: ChecklistItem[];
}

export interface Checklist {
  sections: ChecklistSection[];
  /** The agent's latest change in place: the items it ticked, reworded or added, which flash once. */
  agentEdit?: { at: number; items: string[] };
}

export const checklistItems = (checklist: Checklist) => checklist.sections.flatMap((section) => section.items);

export function checklistProgress(items: { done: boolean }[]) {
  return { done: items.filter((item) => item.done).length, total: items.length };
}
