import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionMeta } from "../host/acp/harnesses.ts";
import { canvasInstructions, canvasUseGuidance } from "../host/canvas/guidance.ts";
import { pluginItemOfSavedChecklist, type SavedChecklist } from "../host/saved-checklists.ts";
import { Store } from "../host/store.ts";
import type { CanvasItem, PluginCanvasItem } from "../shared/model.ts";
import type { Checklist } from "../plugins/checklist/checklist.ts";
import { canvasPluginHost, storeWithConversation } from "./canvas-plugin-host.ts";

const SHIPPED = join(import.meta.dir, "..", "plugins");
const NO_PLUGINS_OF_THE_OWNER = join(tmpdir(), "mirador-no-plugins-here");

const setUp = (store?: Store) => canvasPluginHost(NO_PLUGINS_OF_THE_OWNER, SHIPPED, store);

const release = { title: "Release", sections: [{ items: [{ id: "tests", text: "Run the tests" }, { id: "build", text: "Build the app" }] }] };

const dataOf = (item: PluginCanvasItem | undefined) => item?.data as Checklist;
const doneStates = (item: PluginCanvasItem | undefined) => dataOf(item).sections.flatMap(({ items }) => items.map(({ done }) => done));

describe("the checklist plugin Mirador comes with", () => {
  test("its tools are pre-allowed, and its lines of guidance stand where the checklist's always stood", async () => {
    const { plugins } = await setUp();
    const { guidance } = plugins;
    expect(guidance.toolNames).toEqual(expect.arrayContaining(["checklist", "update_checklist"]));
    expect(claudeSessionMeta("often", { canvasPlugins: guidance }).claudeCode.options.allowedTools).toEqual(expect.arrayContaining(["mcp__canvas__checklist", "mcp__canvas__update_checklist"]));
    expect(canvasInstructions("http://127.0.0.1:4601", guidance)).toContain("\"change some answers\" as options.\n- checklist: when you work through several steps,");
    expect(canvasInstructions("http://127.0.0.1:4601", guidance)).toContain("or in update_checklist's result.\n- review:");
    expect(canvasUseGuidance(guidance)).toContain("add a preview when it helps.\n- checklist: work with several steps,");
    expect(canvasUseGuidance(guidance)).toContain("don't keep the same steps in your to-do list too.\n- tour:");
  });

  test("a published checklist goes in the tab with its count; the agent's ticks change it in place, as the agent's change", async () => {
    const { callTool, items } = await setUp();
    expect((await callTool("checklist", release)).text).toBe(
      "Shown to the user in the canvas's Checklist tab: 2 items, 0 of 2 done. Tick items with update_checklist as you finish them, naming them by id: tests, build.",
    );
    expect(items()[0]).toMatchObject({ plugin: "checklist", type: "checklist", icon: "☑", placement: "tab", title: "Release", count: "0/2" });
    expect(items()[0]).not.toHaveProperty("agentEditedAt");

    expect((await callTool("update_checklist", { items: [{ id: "tests", done: true }] })).text).toBe('On the checklist, updated "tests"; 1 of 2 done.');
    expect(items()[0]).toMatchObject({ count: "1/2", agentEditedAt: expect.any(Number), data: { agentChanged: ["tests"] } });
  });

  test("the user's tick in the view reaches the agent with the next message, once, and isn't the agent's change", async () => {
    const { plugins, callTool, items } = await setUp();
    await callTool("checklist", release);
    const checklistId = items()[0]!.id;
    expect(await plugins.act(checklistId, { kind: "tick", itemId: "build", done: true })).toBeNull();
    expect(items()[0]).toMatchObject({ count: "1/2" });
    expect(items()[0]).not.toHaveProperty("agentEditedAt");
    await expect(plugins.act(checklistId, { kind: "tick", itemId: "lint", done: true })).rejects.toThrow("Unknown checklist item.");
    await expect(plugins.act(checklistId, { kind: "press" })).rejects.toThrow("A checklist item can only be ticked or unticked.");

    const [note] = plugins.notesForAgent("c1");
    expect(note!.text).toBe('On your checklist "Release", the user ticked "build" (Build the app).');
    note!.heard();
    expect(plugins.notesForAgent("c1")).toEqual([]);
    expect(items()[0]).not.toHaveProperty("agentEditedAt");
  });

  test("tool problems reach the agent as the core's checklist worded them", async () => {
    const { callTool } = await setUp();
    expect(await callTool("update_checklist", { items: [{ id: "tests", done: true }] })).toEqual({
      text: "The checklist was not changed. Fix these and call update_checklist again:\n- This conversation has no checklist; publish one with the checklist tool.",
      isError: true,
    });
    const twice = { title: "T", sections: [{ items: [{ id: "a", text: "A" }, { id: "a", text: "A again" }] }] };
    expect(await callTool("checklist", twice)).toEqual({
      text: 'The checklist was not shown. Fix these and call checklist again:\n- "a" names more than one item; give each item its own id.',
      isError: true,
    });
  });
});

describe("a checklist dismissed by the user", () => {
  async function dismissedAfterTicking(...tickedIds: string[]) {
    const host = await setUp();
    await host.callTool("checklist", release);
    const item = host.items()[0]!;
    for (const itemId of tickedIds) await host.plugins.act(item.id, { kind: "tick", itemId, done: true });
    host.plugins.dismiss(item.id);
    return host;
  }

  test("ticks made before dismissing reach the agent once, with the next message", async () => {
    const { plugins } = await dismissedAfterTicking("tests", "build");
    const [note] = plugins.notesForAgent("c1");
    expect(note!.text).toBe('On your checklist "Release", the user ticked "tests" (Run the tests), "build" (Build the app).');
    note!.heard();
    expect(plugins.notesForAgent("c1")).toEqual([]);
  });

  test("with nothing unheard, there's no note", async () => {
    const { plugins } = await dismissedAfterTicking();
    expect(plugins.notesForAgent("c1")).toEqual([]);
  });

  test("update_checklist after the dismissal says the user dismissed it, and does not invite publishing again", async () => {
    const { callTool } = await dismissedAfterTicking("tests");
    expect(await callTool("update_checklist", { items: [{ id: "tests", done: true }] })).toEqual({
      text: "The checklist was not changed:\n- The user dismissed this conversation's checklist; don't publish it again unless they ask for one.",
      isError: true,
    });
  });

  test("publishing after the dismissal starts afresh and reports the ticks the agent had not heard", async () => {
    const { callTool, items, plugins } = await dismissedAfterTicking("tests");
    expect((await callTool("checklist", release)).text).toBe(
      'Shown to the user in the canvas\'s Checklist tab: 2 items, 0 of 2 done. On the checklist it replaces ("Release"), the user ticked "tests" (Run the tests). Tick items with update_checklist as you finish them, naming them by id: tests, build.',
    );
    expect(doneStates(items()[1])).toEqual([false, false]);
    expect(plugins.notesForAgent("c1")).toEqual([]);
  });

  test("publishing after the dismissal reports nothing more once the note delivered the ticks", async () => {
    const { callTool, plugins } = await dismissedAfterTicking("tests");
    plugins.notesForAgent("c1")[0]!.heard();
    expect((await callTool("checklist", release)).text).not.toContain("the user ticked");
  });
});

const saved: SavedChecklist = {
  id: "saved-1",
  conversationId: "c1",
  kind: "checklist",
  title: "Release 0.4.2",
  status: "shown",
  createdAt: 5,
  updatedAt: 6,
  checklist: {
    sections: [
      {
        title: "Build",
        items: [
          { id: "tests", text: "Run the tests", owner: "agent", done: true, heardDone: true },
          { id: "build", text: "Build the app", owner: "user", done: false, heardDone: false },
        ],
      },
    ],
    agentEdit: { at: 6, items: ["tests"] },
    dismissed: true,
  },
};

describe("checklists saved before the checklist was a plugin", () => {
  test("become the plugin's items, as they were, changed now", () => {
    expect(pluginItemOfSavedChecklist(saved, 100)).toEqual({
      id: "saved-1",
      conversationId: "c1",
      kind: "plugin",
      plugin: "checklist",
      type: "checklist",
      icon: "☑",
      placement: "tab",
      count: "1/2",
      title: "Release 0.4.2",
      status: "shown",
      createdAt: 5,
      updatedAt: 100,
      data: { sections: saved.checklist.sections, agentChanged: ["tests"] },
      dismissed: true,
      agentEditedAt: 6,
    });
    const { agentEdit: _, dismissed: __, ...plain } = saved.checklist;
    expect(pluginItemOfSavedChecklist({ ...saved, checklist: plain }, 100)).not.toHaveProperty("dismissed");
  });

  test("are handed to the plugin when Mirador opens its database, once, and the agent goes on changing them", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "saved-checklists-")), "state.sqlite");
    const before = storeWithConversation(path);
    before.saveCanvasItem({ ...saved, checklist: { ...saved.checklist, dismissed: false } } as unknown as CanvasItem);
    before.close();

    const opened = new Store(path);
    const [migrated] = opened.listCanvasItems("c1") as PluginCanvasItem[];
    expect(migrated).toMatchObject({ id: "saved-1", kind: "plugin", plugin: "checklist", count: "1/2" });
    opened.close();

    const openedAgain = new Store(path);
    expect(openedAgain.listCanvasItems("c1")).toEqual([migrated!]);
    const { callTool, items } = await setUp(openedAgain);
    expect((await callTool("update_checklist", { items: [{ id: "build", done: true }] })).text).toBe('On the checklist, updated "build"; 2 of 2 done.');
    expect(items()[0]).toMatchObject({ id: "saved-1", count: "2/2" });
  });
});
