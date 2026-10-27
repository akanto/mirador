import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionMeta } from "../host/acp/harnesses.ts";
import { loadPlugins } from "../host/apps/plugins.ts";
import { canvasInstructions, canvasUseGuidance } from "../host/canvas/guidance.ts";
import type { PluginCanvasItem } from "../shared/model.ts";
import { Store } from "../host/store.ts";
import type { PluginCatalog } from "../host/plugin-catalog.ts";
import type { FirstReply } from "../shared/canvas-plugins.ts";
import { canvasPluginHost, storeWithConversation } from "./canvas-plugin-host.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "canvas-plugins");

const setUp = () => canvasPluginHost(FIXTURES);

describe("CanvasPlugins", () => {
  test("a plugin's tools join the canvas server, pre-allowed, with its lines of guidance", async () => {
    const { plugins, mcpRequest } = await setUp();
    const { tools } = await mcpRequest("tools/list", {});
    expect(tools.map(({ name }: { name: string }) => name)).toEqual(expect.arrayContaining(["show", "show_card", "change_card", "show_report", "change_verdict", "track_steps", "finish_step"]));
    expect(tools.find(({ name }: { name: string }) => name === "show_card")).toMatchObject({ description: "Show a card the user can press.", _meta: { "anthropic/alwaysLoad": true } });

    const { guidance } = plugins;
    expect(guidance.toolNames).toEqual(["show_card", "change_card", "show_report", "change_verdict", "track_steps", "finish_step", "hand_over"]);
    expect(canvasInstructions("http://127.0.0.1:4601", guidance)).toContain("\"change some answers\" as options.\n- show_card: show a card the user can press.\n\nRendering environment:");
    expect(canvasUseGuidance(guidance)).toContain("add a preview when it helps.\n- show_card: when a card says it better than words.\n- Keep pages lean");
    expect(claudeSessionMeta("often", { canvasPlugins: guidance }).claudeCode.options.allowedTools).toContain("mcp__canvas__show_card");
  });

  test("official plugins not installed join the guidance, with the tool that installs one, pre-allowed since it asks the user first", async () => {
    const { plugins } = await setUp();
    const offered = [{ name: "media", title: "Media", description: "Edit a video.", recommendWhen: "the user edits a video", repo: "https://example.com/media.git" }];
    plugins.offersFrom({ notInstalled: () => offered } as unknown as PluginCatalog);
    const { guidance } = plugins;
    expect(guidance.toolNames.at(-1)).toBe("plugin_install");
    expect(canvasInstructions("http://127.0.0.1:4601", guidance)).toContain("- show_card: show a card the user can press.\n- plugin_install: official Mirador plugins");
    expect(claudeSessionMeta("often", { canvasPlugins: guidance }).claudeCode.options.allowedTools).toContain("mcp__canvas__plugin_install");

    plugins.offersFrom({ notInstalled: () => [] } as unknown as PluginCatalog);
    expect(plugins.guidance.toolNames).not.toContain("plugin_install");
  });

  test("a tool publishes an item, and another changes it in place as the agent's change", async () => {
    const { callTool, items, published } = await setUp();
    const shown = await callTool("show_card", { title: "Hello", text: "First" });
    const [card] = items();
    expect(shown).toEqual({ text: `Shown as ${card!.id}.`, isError: false });
    expect(card).toMatchObject({ kind: "plugin", plugin: "board", type: "card", icon: "▤", placement: "page", title: "Hello", status: "shown", data: { text: "First", presses: 0 } });
    expect(card).not.toHaveProperty("agentEditedAt");

    expect(await callTool("change_card", { text: "Second" })).toEqual({ text: "Changed.", isError: false });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ id: card!.id, data: { text: "Second" }, agentEditedAt: expect.any(Number) });
    expect(published.map((message) => message.type === "canvas.upserted" && (message.item as PluginCanvasItem).data)).toEqual([
      { text: "First", presses: 0, heardPresses: 0 },
      { text: "Second", presses: 0, heardPresses: 0 },
    ]);
  });

  test("what a tool throws, and arguments its schema refuses, reach the agent as tool errors and change nothing", async () => {
    const { callTool, items } = await setUp();
    expect(await callTool("change_card", { text: "Second" })).toEqual({ text: "There is no card to change; show one with show_card.", isError: true });
    const refused = await callTool("show_card", { text: "No title" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("title");
    expect(items()).toEqual([]);
  });

  test("an item in the tab carries its count, kept up to date", async () => {
    const { callTool, items } = await setUp();
    await callTool("track_steps", { title: "Release", steps: ["Build", "Ship"] });
    expect(items()[0]).toMatchObject({ type: "steps", icon: "◔", placement: "tab", count: "0/2" });
    await callTool("finish_step", {});
    expect(items()[0]).toMatchObject({ count: "1/2" });
  });

  test("the user's action reaches the plugin and its reply comes back; the agent hears of it with the next message, once", async () => {
    const { plugins, callTool, items } = await setUp();
    await callTool("show_card", { title: "Hello", text: "First" });
    const cardId = items()[0]!.id;

    expect(await plugins.act(cardId, { kind: "press" })).toEqual({ presses: 1 });
    expect(await plugins.act(cardId, { kind: "press" })).toEqual({ presses: 2 });
    expect(items()[0]).not.toHaveProperty("agentEditedAt");
    await expect(plugins.act(cardId, { kind: "fold" })).rejects.toThrow("A card can only be pressed.");
    await expect(plugins.act("nothing-like-it", { kind: "press" })).rejects.toThrow("Unknown item.");

    const [note] = plugins.notesForAgent("c1");
    expect(note!.text).toBe('The user pressed the card "Hello" 2 times.');
    note!.heard();
    expect(plugins.notesForAgent("c1")).toEqual([]);
  });

  test("an item carries what came of it, kept up to date, and whether it opens with room", async () => {
    const { callTool, items } = await setUp();
    await callTool("show_report", { title: "Report", verdict: "" });
    expect(items()[0]).toMatchObject({ opensWithRoom: true });
    expect(items()[0]).not.toHaveProperty("outcome");
    await callTool("change_verdict", { verdict: "Approve" });
    expect(items()[0]).toMatchObject({ outcome: "Approve" });
    await callTool("change_verdict", { verdict: "" });
    expect(items()[0]).not.toHaveProperty("outcome");
    await callTool("show_card", { title: "Hello", text: "First" });
    expect(items()[1]).not.toHaveProperty("opensWithRoom");
  });

  test("the canvas lists an item as its plugin makes of it, such as without a hold a restart cut short", async () => {
    const { plugins, callTool, items } = await setUp();
    await callTool("show_report", { title: "Held now", verdict: "Approve" });
    await callTool("show_report", { title: "Held before", verdict: "Approve" });
    const [now, before] = items();
    await plugins.act(now!.id, { kind: "hold", inThisRun: true });
    await plugins.act(before!.id, { kind: "hold", inThisRun: false });
    expect(items().map((item) => plugins.listed(item).data)).toMatchObject([{ holding: true }, { holding: false }]);
    expect(items()[1]).toMatchObject({ data: { holding: true } });
  });

  test("the canvas lists an item with what came of it as its plugin says now, such as one saved before the plugin changed how it says it", async () => {
    const { plugins, callTool, items } = await setUp();
    await callTool("show_report", { title: "Report", verdict: "Approve" });
    const item = items()[0]!;
    expect(plugins.listed(item)).toBe(item);
    expect(plugins.listed({ ...item, outcome: "Approve, said at length" })).toMatchObject({ outcome: "Approve", updatedAt: item.updatedAt });
  });

  test("a plugin keeps what it stores across conversations and restarts, apart from other plugins", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "canvas-storage-")), "state.sqlite");
    const first = await canvasPluginHost(FIXTURES, storeWithConversation(path));
    await first.callTool("show_card", { title: "Hello", text: "First" });
    const cardId = first.items()[0]!.id;
    expect(await first.plugins.act(cardId, { kind: "remember", key: "split", value: { list: 0.3 } })).toEqual({ list: 0.3 });
    first.store.close();

    const second = new Store(path);
    expect(second.canvasPluginStorageItem("board", "split")).toEqual({ list: 0.3 });
    expect(second.canvasPluginStorageItem("other", "split")).toBeUndefined();
    second.saveCanvasPluginStorageItem("board", "split", undefined);
    expect(second.canvasPluginStorageItem("board", "split")).toBeUndefined();
  });

  test("the user's action can send the agent a message, after its turn if asked", async () => {
    const { plugins, callTool, items } = await setUp();
    const sent: unknown[] = [];
    plugins.sendsPromptsWith(async (conversationId, text, options) => void sent.push({ conversationId, text, options }));
    await callTool("show_card", { title: "Hello", text: "First" });
    await plugins.act(items()[0]!.id, { kind: "ask", text: "Look again", afterTurn: true });
    await plugins.act(items()[0]!.id, { kind: "ask", text: "Now" });
    expect(sent).toEqual([
      { conversationId: "c1", text: "Look again", options: { afterTurn: true } },
      { conversationId: "c1", text: "Now", options: { afterTurn: false } },
    ]);
  });

  test("a tool starts a conversation on another profile, and messages its agent after the turn with that conversation's first reply", async () => {
    const { plugins, prompts, callTool } = await setUp();
    let finishFirstTurn = () => {};
    const started: unknown[] = [];
    plugins.startsConversationsWith((callerId, profileName, prompt) => {
      started.push({ callerId, profileName, prompt });
      const firstReply = new Promise<FirstReply>((resolve) => (finishFirstTurn = () => resolve({ text: "Found 3 callers.", ended: "finished" })));
      return { id: "c2", firstReply };
    });

    expect(await callTool("hand_over", { profile: "Local", task: "Find the callers of run" })).toEqual({ text: "Handed over to c2.", isError: false });
    expect(started).toEqual([{ callerId: "c1", profileName: "Local", prompt: "Find the callers of run" }]);
    expect(prompts).toEqual([]);

    finishFirstTurn();
    await Bun.sleep(0);
    expect(prompts).toEqual([{ conversationId: "c1", text: "The handed-over task finished: Found 3 callers.", afterTurn: true }]);
  });

  test("a conversation that can't be started reaches the agent as a tool error", async () => {
    const { plugins, callTool } = await setUp();
    plugins.startsConversationsWith(() => {
      throw new Error("There is no profile named Nope; the profiles are Local.");
    });
    expect(await callTool("hand_over", { profile: "Nope", task: "Anything" })).toEqual({ text: "There is no profile named Nope; the profiles are Local.", isError: true });
  });

  test("the user dismisses an item in the tab, and its plugin knows; a page can't be dismissed", async () => {
    const { plugins, callTool, items } = await setUp();
    await callTool("track_steps", { title: "Release", steps: ["Build"] });
    await callTool("show_card", { title: "Hello", text: "First" });
    const [steps, card] = items();
    plugins.dismiss(steps!.id);
    expect(items()[0]).toMatchObject({ dismissed: true });
    expect(await callTool("finish_step", {})).toEqual({ text: "There are no steps to tick off.", isError: true });
    expect(() => plugins.dismiss(card!.id)).toThrow("Only an item in the tab can be dismissed.");
  });

  test("serves each plugin's canvas view under a hash of its code", async () => {
    const { plugins } = await setUp();
    const path = plugins.viewPaths().board!;
    expect(path).toMatch(/^\/apps\/board\/[0-9a-f]{16}\/canvas\.js$/);
    expect(new TextDecoder().decode(plugins.viewCode(path)!)).toBe(readFileSync(join(FIXTURES, "board", "canvas.js"), "utf8"));
    expect(plugins.viewCode("/apps/board/0000000000000000/canvas.js")).toBeNull();
  });
});

describe("loading canvas plugins", () => {
  function boardCopy(change: (manifest: Record<string, unknown>) => Record<string, unknown>, hostSource?: string) {
    const folder = mkdtempSync(join(tmpdir(), "canvas-plugins-"));
    cpSync(join(FIXTURES, "board"), join(folder, "board"), { recursive: true });
    const manifestFile = join(folder, "board", "plugin.json");
    writeFileSync(manifestFile, JSON.stringify(change(JSON.parse(readFileSync(manifestFile, "utf8")))));
    if (hostSource) writeFileSync(join(folder, "board", "host.ts"), hostSource);
    return folder;
  }

  test("refuses a canvas part in a plugin.json for an API before canvas tools", async () => {
    const { canvases, problems } = await loadPlugins(boardCopy((manifest) => ({ ...manifest, api: 2 })));
    expect(canvases).toEqual([]);
    expect(problems.map(({ message }) => message)).toEqual(["plugin.json has a canvas part, which plugin API 3 brought; it names API 2"]);
  });

  test("refuses a tool named as one of Mirador's own or another plugin's, and a canvas host module that lacks what it needs", async () => {
    const takesShow = boardCopy((manifest) => manifest, `export default { items: {}, tools: { show: { description: "d", input: { type: "object" }, run: () => "" } } };`);
    expect((await loadPlugins(takesShow)).problems.map(({ message }) => message)).toEqual(["its tool show has the name of one of Mirador's own canvas tools"]);

    const twice = boardCopy((manifest) => manifest);
    cpSync(join(twice, "board"), join(twice, "second-board"), { recursive: true });
    const secondManifest = join(twice, "second-board", "plugin.json");
    writeFileSync(secondManifest, readFileSync(secondManifest, "utf8").replace('"name":"board"', '"name":"second-board"'));
    const loadedTwice = await loadPlugins(twice);
    expect(loadedTwice.canvases.map(({ manifest }) => manifest.name)).toEqual(["board"]);
    expect(loadedTwice.problems.map(({ message }) => message)).toEqual(["its tool show_card has the name of a tool of board"]);

    const lacking = boardCopy((manifest) => manifest, `export default { items: { card: { icon: "▤", placement: "floating" } }, tools: { "Show-Card": { description: "d" } }, note: "later" };`);
    expect((await loadPlugins(lacking)).problems.map(({ message }) => message)).toEqual([
      "the canvas host module needs items.card with an icon, a placement of page or tab, and count, outcome and listed only as functions; tools named in lower case, digits and underscores, not Show-Card; tools.Show-Card with a description, an input schema and a run function; note only as a function",
    ]);
  });

  const roomSetting = { id: "open-reports", label: "Open reports", choices: [{ value: "fullscreen", label: "Full screen" }, { value: "beside", label: "Beside" }], default: "beside" };
  const reportOpeningWith = (opensWithRoom: string) =>
    `export default { items: { report: { icon: "▥", placement: "page", opensWithRoom: ${opensWithRoom} } }, tools: { show_report: { description: "d", input: { type: "object" }, run: (_input, context) => (context.publish({ type: "report", title: "Report", data: {} }), "") } } };`;

  test("refuses settings in plugin.json without a default among their choices, or with an id twice", async () => {
    const withoutDefault = boardCopy((manifest) => ({ ...manifest, settings: [{ ...roomSetting, default: "elsewhere" }] }));
    const twice = boardCopy((manifest) => ({ ...manifest, settings: [roomSetting, roomSetting] }));
    for (const folder of [withoutDefault, twice]) {
      const { canvases, problems } = await loadPlugins(folder);
      expect(canvases).toEqual([]);
      expect(problems[0]!.message).toContain("each of its settings, if any, an id of its own");
    }
  });

  test("an item opens with the room a setting of its plugin says only if that setting's choices are the rooms", async () => {
    const elsewhere = boardCopy((manifest) => ({ ...manifest, settings: [{ ...roomSetting, choices: [...roomSetting.choices, { value: "elsewhere", label: "Elsewhere" }] }] }), reportOpeningWith('{ setting: "open-reports" }'));
    expect((await loadPlugins(elsewhere)).problems.map(({ message }) => message)).toEqual([
      "the canvas host module needs items.report with opensWithRoom only as true or false, or as { setting } naming a setting of plugin.json whose choices are fullscreen and beside",
    ]);
    const unnamed = boardCopy((manifest) => ({ ...manifest, settings: [roomSetting] }), reportOpeningWith('{ setting: "open-cards" }'));
    expect((await loadPlugins(unnamed)).problems).toHaveLength(1);

    const { callTool, items } = await canvasPluginHost(boardCopy((manifest) => ({ ...manifest, settings: [roomSetting] }), reportOpeningWith('{ setting: "open-reports" }')));
    await callTool("show_report", {});
    expect(items()[0]).toMatchObject({ opensWithRoom: true, roomSetting: "open-reports" });
  });
});
