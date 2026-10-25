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

/** The checklist item's data. */
export interface Checklist {
  sections: ChecklistSection[];
  /** The items the agent's latest change in place ticked, reworded or added, which flash once. */
  agentChanged?: string[];
}

export const checklistItems = (checklist: Checklist) => checklist.sections.flatMap((section) => section.items);

export function checklistProgress(items: { done: boolean }[]) {
  return { done: items.filter((item) => item.done).length, total: items.length };
}

/** What the agent hears instead of a result: the lead, then each problem on a line of its own. */
export class ChecklistProblems extends Error {
  constructor(
    readonly problems: string[],
    lead: string,
  ) {
    super(`${lead}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

const definedOnly = <T extends object>(fields: T) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;

export interface NewChecklistItem {
  id: string;
  text: string;
  detail?: string;
  owner?: ChecklistOwner;
  done?: boolean;
}

export interface ChecklistRequest {
  title: string;
  sections: { title?: string; items: NewChecklistItem[] }[];
}

export type ChecklistItemEdit = Partial<Omit<NewChecklistItem, "id">> & { id: string };

export type AddedChecklistItem = NewChecklistItem & { after?: string; section?: string };

/** What the agent changes on the checklist it published, naming items by their ids. */
export interface ChecklistEdit {
  items?: ChecklistItemEdit[];
  addItems?: AddedChecklistItem[];
  removeItems?: string[];
}

/** An item the user ticked or unticked since the agent last heard. */
export interface UserTick {
  id: string;
  text: string;
  done: boolean;
}

const CHECKLIST_NOT_SHOWN = "The checklist was not shown. Fix these and call checklist again";
export const CHECKLIST_NOT_CHANGED = "The checklist was not changed. Fix these and call update_checklist again";
export const CHECKLIST_NOT_CHANGED_LEAD = "The checklist was not changed";
export const CHECKLIST_DISMISSED_BY_USER = "The user dismissed this conversation's checklist; don't publish it again unless they ask for one.";

const fromRequest = ({ id, text, detail, owner }: NewChecklistItem, done: boolean): ChecklistItem => ({
  id,
  text,
  ...(detail && { detail }),
  owner: owner ?? "agent",
  done,
  heardDone: done,
});

const idsUsedTwice = (ids: string[]) => [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];

/** A checklist published again keeps the done state of the items with the same ids, unless the agent says otherwise. */
export function newChecklist(request: ChecklistRequest, earlier: Checklist | undefined): Checklist {
  const twice = idsUsedTwice(request.sections.flatMap((section) => section.items.map(({ id }) => id)));
  if (twice.length > 0) throw new ChecklistProblems(twice.map((id) => `"${id}" names more than one item; give each item its own id.`), CHECKLIST_NOT_SHOWN);
  const doneBefore = new Map((earlier ? checklistItems(earlier) : []).map(({ id, done }) => [id, done]));
  return {
    sections: request.sections.map(({ title, items }) => ({
      ...(title && { title }),
      items: items.map((item) => fromRequest(item, item.done ?? doneBefore.get(item.id) ?? false)),
    })),
  };
}

/** The items a newly published checklist took over as done from the one it replaced, as the agent left done out. */
export const carriedOverDone = (request: ChecklistRequest, checklist: Checklist) => {
  const leftOut = new Set(request.sections.flatMap((section) => section.items.filter((item) => item.done === undefined).map(({ id }) => id)));
  return checklistItems(checklist).filter((item) => item.done && leftOut.has(item.id));
};

const touchesAnything = (edit: ChecklistEdit) => [edit.items, edit.addItems, edit.removeItems].some((list) => list && list.length > 0);

export function applyChecklistEdit(checklist: Checklist, edit: ChecklistEdit) {
  const problems: string[] = [];
  if (!touchesAnything(edit)) problems.push("Nothing to change: pass items to change, add or take out.");
  const known = new Set(checklistItems(checklist).map(({ id }) => id));
  const isKnown = (id: string) => {
    if (!known.has(id)) problems.push(`"${id}" is not an item of this checklist (${[...known].join(", ")}).`);
    return known.has(id);
  };

  const changes = new Map<string, ChecklistItemEdit>();
  (edit.items ?? []).filter(({ id }) => isKnown(id)).forEach((change) => {
    if (changes.has(change.id)) problems.push(`"${change.id}" is changed twice; change each item once.`);
    changes.set(change.id, change);
  });
  const removed = new Set((edit.removeItems ?? []).filter(isKnown));
  removed.forEach((id) => changes.has(id) && problems.push(`"${id}" is both changed and taken out; pick one.`));
  const added = new Set<string>();
  (edit.addItems ?? []).forEach(({ id, after }) => {
    if (known.has(id) || added.has(id)) problems.push(`"${id}" is already an item's id; give the new item its own.`);
    const placeable = after === undefined || ((known.has(after) || added.has(after)) && !removed.has(after));
    if (!placeable) problems.push(`"${id}" goes after "${after}", which is not an item of this checklist${removed.has(after!) ? " once the ones you take out are gone" : ""}.`);
    added.add(id);
  });
  if (problems.length > 0) throw new ChecklistProblems(problems, CHECKLIST_NOT_CHANGED);

  const sections = checklist.sections.map((section) => ({
    ...section,
    items: section.items.filter(({ id }) => !removed.has(id)).map((item) => changedItem(item, changes.get(item.id))),
  }));
  (edit.addItems ?? []).forEach((addition) => placeNewItem(sections, addition));
  return {
    checklist: { ...checklist, sections: sections.filter((section) => section.items.length > 0) },
    changed: [...changes.keys()],
    added: [...added],
    removed: [...removed],
  };
}

/** A tick of the agent's is one it knows of. */
function changedItem(item: ChecklistItem, change: ChecklistItemEdit | undefined): ChecklistItem {
  if (!change) return item;
  const { id: _, done, ...rest } = change;
  return { ...item, ...definedOnly(rest), ...(done !== undefined && { done, heardDone: done }) };
}

/** Right after the item it names, else at the end of the section it names, made if there is none, else at the end of the last section. */
function placeNewItem(sections: ChecklistSection[], { after, section, ...item }: AddedChecklistItem) {
  const newItem = fromRequest(item, item.done ?? false);
  const holding = after === undefined ? undefined : sections.find(({ items }) => items.some(({ id }) => id === after));
  const named = section === undefined ? sections.at(-1) : sections.find(({ title }) => title === section);
  if (holding) holding.items.splice(holding.items.findIndex(({ id }) => id === after) + 1, 0, newItem);
  else if (named) named.items.push(newItem);
  else sections.push({ ...(section && { title: section }), items: [newItem] });
}

const withItems = (checklist: Checklist, change: (item: ChecklistItem) => ChecklistItem): Checklist => ({
  ...checklist,
  sections: checklist.sections.map((section) => ({ ...section, items: section.items.map(change) })),
});

export const tickedByUser = (checklist: Checklist, itemId: string, done: boolean) => withItems(checklist, (item) => (item.id === itemId ? { ...item, done } : item));

export const unheardTicks = (checklist: Checklist): UserTick[] =>
  checklistItems(checklist)
    .filter((item) => item.done !== item.heardDone)
    .map(({ id, text, done }) => ({ id, text, done }));

/** Only the ticks told to the agent: one the user changed again since is still news. */
export function heardOf(checklist: Checklist, ticks: UserTick[]): Checklist {
  const told = new Map(ticks.map(({ id, done }) => [id, done]));
  return withItems(checklist, (item) => (told.has(item.id) ? { ...item, heardDone: told.get(item.id)! } : item));
}

export const itemNamed = ({ id, text }: { id: string; text: string }) => `"${id}" (${text})`;

export function describeTicks(ticks: UserTick[]) {
  const ticked = ticks.filter(({ done }) => done).map(itemNamed);
  const unticked = ticks.filter(({ done }) => !done).map(itemNamed);
  return [ticked.length > 0 && `ticked ${ticked.join(", ")}`, unticked.length > 0 && `unticked ${unticked.join(", ")}`].filter(Boolean).join(" and ");
}

export const noteOfTicks = (title: string, ticks: UserTick[]) => `On your checklist "${title}", the user ${describeTicks(ticks)}.`;
