import type { CanvasHost, CanvasPluginContext, PluginItem } from "../../shared/canvas-plugins.ts";
import {
  applyChecklistEdit,
  carriedOverDone,
  CHECKLIST_DISMISSED_BY_USER,
  CHECKLIST_NOT_CHANGED,
  CHECKLIST_NOT_CHANGED_LEAD,
  checklistItems,
  checklistOwners,
  checklistProgress,
  ChecklistProblems,
  describeTicks,
  heardOf,
  itemNamed,
  newChecklist,
  noteOfTicks,
  tickedByUser,
  unheardTicks,
  type Checklist,
  type ChecklistEdit,
  type ChecklistItem,
  type ChecklistRequest,
  type UserTick,
} from "./checklist.ts";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

const itemProperties = {
  id: { type: "string", minLength: 1, description: 'A short id you name the item by in update_checklist, e.g. "tests".' },
  text: { type: "string", minLength: 1, description: "The step, in a few words." },
  detail: { description: "Markdown shown under the text: what the step involves, or what came of it.", type: "string" },
  owner: { description: "Who is expected to do it: agent (the default), user, or both. Anyone may tick it.", type: "string", enum: checklistOwners },
  done: { description: "Whether it is done; not done by default.", type: "boolean" },
};

const checklistInput = {
  type: "object",
  $schema: SCHEMA,
  properties: {
    title: { type: "string", minLength: 1, description: 'What the work is, e.g. "Release 0.4.2".' },
    sections: {
      minItems: 1,
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { description: "A heading for the section; leave it out for a list of one section.", type: "string" },
          items: { minItems: 1, type: "array", items: { type: "object", properties: itemProperties, required: ["id", "text"] } },
        },
        required: ["items"],
      },
      description: "The steps, in the order they are done, in one or more sections. Ids are unique across the checklist.",
    },
  },
  required: ["title", "sections"],
};

const checklistEditInput = {
  type: "object",
  $schema: SCHEMA,
  properties: {
    items: {
      description: "Items to tick, untick, reword or hand over: only the fields you pass change.",
      type: "array",
      items: { type: "object", properties: { ...itemProperties, id: { type: "string", minLength: 1, description: "The item to change." } }, required: ["id"] },
    },
    addItems: {
      description: "New items; without after or section, at the end of the last section.",
      type: "array",
      items: {
        type: "object",
        properties: {
          ...itemProperties,
          after: { description: "The item to add it after.", type: "string" },
          section: { description: "Without after: the section to add it at the end of, by title; a title no section has adds a new section at the end.", type: "string" },
        },
        required: ["id", "text"],
      },
    },
    removeItems: { description: "Items to take out, by id.", type: "array", items: { type: "string", minLength: 1 } },
  },
};

const doneCount = (items: { done: boolean }[]) => {
  const { done, total } = checklistProgress(items);
  return `${done} of ${total} done`;
};

const heardTicks = (ticks: UserTick[], when: string) => (ticks.length === 0 ? "" : ` ${when}, the user ${describeTicks(ticks)}.`);

function describeChecklist(checklist: Checklist, carried: ChecklistItem[], replaced: { title: string; ticks: UserTick[] } | undefined) {
  const items = checklistItems(checklist);
  const carriedNote = carried.length > 0 ? ` Done as on the checklist it replaces: ${carried.map(itemNamed).join(", ")}.` : "";
  const replacedNote = replaced ? heardTicks(replaced.ticks, `On the checklist it replaces ("${replaced.title}")`) : "";
  return `Shown to the user in the canvas's Checklist tab: ${items.length} items, ${doneCount(items)}.${carriedNote}${replacedNote} Tick items with update_checklist as you finish them, naming them by id: ${items.map(({ id }) => id).join(", ")}.`;
}

function describeChecklistEdit(checklist: Checklist, { changed, added, removed, ticks }: { changed: string[]; added: string[]; removed: string[]; ticks: UserTick[] }) {
  const quoted = (ids: string[]) => ids.map((id) => `"${id}"`).join(", ");
  const done = [changed.length > 0 && `updated ${quoted(changed)}`, added.length > 0 && `added ${quoted(added)}`, removed.length > 0 && `took out ${quoted(removed)}`]
    .filter(Boolean)
    .join(", ");
  return `On the checklist, ${done}; ${doneCount(checklistItems(checklist))}.${heardTicks(ticks, "Since you last heard")}`;
}

/** The conversation's checklist is its newest published one, dismissed or not: the user's ticks on a dismissed one still reach the agent once. */
const newestChecklist = (context: CanvasPluginContext<Checklist>) => context.items().findLast((item) => item.type === "checklist");

/** What the user does in the view: tick or untick one item. */
interface Tick {
  kind: "tick";
  itemId: string;
  done: boolean;
}

const isTick = (action: unknown): action is Tick => {
  const { kind, itemId, done } = (action ?? {}) as Partial<Tick>;
  return kind === "tick" && typeof itemId === "string" && typeof done === "boolean";
};

function tick(item: PluginItem<Checklist>, action: unknown, context: CanvasPluginContext<Checklist>) {
  if (!isTick(action)) throw new Error("A checklist item can only be ticked or unticked.");
  if (!checklistItems(item.data).some(({ id }) => id === action.itemId)) throw new Error("Unknown checklist item.");
  context.change(item.id, { data: tickedByUser(item.data, action.itemId, action.done) });
  return null;
}

const host: CanvasHost<Checklist> = {
  items: {
    checklist: {
      icon: "☑",
      placement: "tab",
      count: (checklist) => {
        const { done, total } = checklistProgress(checklistItems(checklist));
        return `${done}/${total}`;
      },
    },
  },
  tools: {
    checklist: {
      description:
        "Publish a checklist of the steps of your work in a tab beside the user's canvas, and tick its items with update_checklist as you finish them. The user sees how far along you are, and can tick items too: you hear of their ticks with their next message or in update_checklist's result. Each item is yours, the user's or both of yours to do. A conversation has one checklist: publishing again replaces it, and items with the same ids keep their ticks unless you pass done. If the user dismisses the checklist, don't publish it again unless they ask for one.",
      input: checklistInput,
      run(input, context) {
        const request = input as ChecklistRequest;
        const replaced = newestChecklist(context);
        const checklist = newChecklist(request, replaced && !replaced.dismissed ? replaced.data : undefined);
        context.publish({ type: "checklist", title: request.title, data: checklist });
        return describeChecklist(checklist, carriedOverDone(request, checklist), replaced && { title: replaced.title, ticks: unheardTicks(replaced.data) });
      },
    },
    update_checklist: {
      description:
        "Change the checklist already beside the canvas, in place: tick or untick items, reword them, hand them over, add or take them out, by the ids you gave them. The items you change flash once for the user. The result tells you what the user ticked or unticked since you last heard. Unknown ids change nothing; the result lists them.",
      input: checklistEditInput,
      run(input, context) {
        const current = newestChecklist(context);
        if (!current) throw new ChecklistProblems(["This conversation has no checklist; publish one with the checklist tool."], CHECKLIST_NOT_CHANGED);
        if (current.dismissed) throw new ChecklistProblems([CHECKLIST_DISMISSED_BY_USER], CHECKLIST_NOT_CHANGED_LEAD);
        const { checklist, changed, added, removed } = applyChecklistEdit(current.data, input as ChecklistEdit);
        const ticks = unheardTicks(checklist);
        const { data } = context.change(current.id, { data: { ...heardOf(checklist, ticks), agentChanged: [...changed, ...added] } });
        return describeChecklistEdit(data, { changed, added, removed, ticks });
      },
    },
  },
  guidance: {
    instructions:
      "- checklist: when you work through several steps, publish them as a checklist the user sees beside the canvas, and tick each item with update_checklist as you finish it. An item is yours, the user's or both of yours to do; the user can tick any of them, and you hear of their ticks with their next message or in update_checklist's result.",
    often:
      "- checklist: work with several steps, such as a feature, a release or a migration. Publish the steps before you start, tick each one with update_checklist as you finish it, and mark the ones the user has to do as theirs. The user follows along beside the chat. Your own to-do list already shows pinned under the checklist, so while a checklist tracks the work, don't keep the same steps in your to-do list too.",
  },
  action: tick,
  /** What the user ticked, for the agent with their next message; once the message is sent, the agent has heard. */
  note(context) {
    const current = newestChecklist(context);
    const ticks = current ? unheardTicks(current.data) : [];
    if (!current || ticks.length === 0) return null;
    return {
      text: noteOfTicks(current.title, ticks),
      heard: () => {
        const latest = context.items().find(({ id }) => id === current.id);
        if (latest) context.change(latest.id, { data: heardOf(latest.data, ticks) });
      },
    };
  },
};

export default host;
