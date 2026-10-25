import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionMeta } from "../host/acp/harnesses.ts";
import { loadPlugins } from "../host/apps/plugins.ts";
import type { ConversationService } from "../host/conversations.ts";
import { canvasInstructions, canvasUseGuidance } from "../host/canvas/guidance.ts";
import { CanvasMcpEndpoints } from "../host/canvas/mcp.ts";
import { CanvasPlugins } from "../host/canvas/plugins.ts";
import type { CanvasService } from "../host/canvas/service.ts";
import type { Hub } from "../host/hub.ts";
import { Store } from "../host/store.ts";
import type { PluginCanvasItem } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "canvas-plugins");

async function setUp() {
  const store = new Store(":memory:");
  store.insertWorkspace({ id: "w1", name: "p", path: "/tmp/p", defaultLaunch: { harness: "claude", profileId: null }, createdAt: 1 });
  store.insertConversation({
    id: "c1",
    workspaceId: "w1",
    harness: "claude",
    profileId: null,
    title: "t",
    titleSetByUser: false,
    acpSessionId: null,
    askMode: "wait",
    bypassPermissions: false,
    status: "idle",
    statusDetail: null,
    openInTerminal: null,
    contextUsage: null,
    queuedMessages: [],
    usageLimit: null,
    jobWaits: [],
    asyncTasks: [],
    waitingFor: null,
    pendingRequest: null,
    lastWords: null,
    activity: null,
    configOptions: [],
    createdAt: 1,
    updatedAt: 1,
  });
  const published: ServerMessage[] = [];
  const hub = { publishToConversation: (_conversationId: string, message: ServerMessage) => void published.push(message) } as unknown as Hub;
  const loaded = await loadPlugins(FIXTURES);
  expect(loaded.problems).toEqual([]);
  const plugins = new CanvasPlugins(store, hub, loaded.canvases);
  const endpoints = new CanvasMcpEndpoints({} as CanvasService, {} as ConversationService, "http://127.0.0.1:4601", null, plugins);
  const items = () => store.listCanvasItems("c1") as PluginCanvasItem[];
  return { store, plugins, endpoints, published, items };
}

async function mcpRequest(endpoints: CanvasMcpEndpoints, method: string, params: Record<string, unknown>) {
  const response = await endpoints.handle(
    "c1",
    new Request("http://127.0.0.1/mcp/c1", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const body = await response.text();
  const payload = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(payload ?? body).result;
}

async function callTool(endpoints: CanvasMcpEndpoints, name: string, args: Record<string, unknown>) {
  const result = await mcpRequest(endpoints, "tools/call", { name, arguments: args });
  return { text: result.content[0].text as string, isError: result.isError === true };
}

describe("CanvasPlugins", () => {
  test("a plugin's tools join the canvas server, pre-allowed, with its lines of guidance", async () => {
    const { plugins, endpoints } = await setUp();
    const { tools } = await mcpRequest(endpoints, "tools/list", {});
    expect(tools.map(({ name }: { name: string }) => name)).toEqual(expect.arrayContaining(["show", "show_card", "change_card", "track_steps", "finish_step"]));
    expect(tools.find(({ name }: { name: string }) => name === "show_card")).toMatchObject({ description: "Show a card the user can press.", _meta: { "anthropic/alwaysLoad": true } });

    const { guidance } = plugins;
    expect(guidance.toolNames).toEqual(["show_card", "change_card", "track_steps", "finish_step"]);
    expect(canvasInstructions("http://127.0.0.1:4601", guidance)).toContain("update_checklist's result.\n- show_card: show a card the user can press.\n\nRendering environment:");
    expect(canvasUseGuidance(guidance)).toContain("in your to-do list too.\n- show_card: when a card says it better than words.\n- Keep pages lean");
    expect(claudeSessionMeta("often", { canvasPlugins: guidance }).claudeCode.options.allowedTools).toContain("mcp__canvas__show_card");
  });

  test("a tool publishes an item, and another changes it in place as the agent's change", async () => {
    const { endpoints, items, published } = await setUp();
    const shown = await callTool(endpoints, "show_card", { title: "Hello", text: "First" });
    const [card] = items();
    expect(shown).toEqual({ text: `Shown as ${card!.id}.`, isError: false });
    expect(card).toMatchObject({ kind: "plugin", plugin: "board", type: "card", icon: "▤", placement: "page", title: "Hello", status: "shown", data: { text: "First", presses: 0 } });
    expect(card).not.toHaveProperty("agentEditedAt");

    expect(await callTool(endpoints, "change_card", { text: "Second" })).toEqual({ text: "Changed.", isError: false });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ id: card!.id, data: { text: "Second" }, agentEditedAt: expect.any(Number) });
    expect(published.map((message) => message.type === "canvas.upserted" && (message.item as PluginCanvasItem).data)).toEqual([
      { text: "First", presses: 0, heardPresses: 0 },
      { text: "Second", presses: 0, heardPresses: 0 },
    ]);
  });

  test("what a tool throws, and arguments its schema refuses, reach the agent as tool errors and change nothing", async () => {
    const { endpoints, items } = await setUp();
    expect(await callTool(endpoints, "change_card", { text: "Second" })).toEqual({ text: "There is no card to change; show one with show_card.", isError: true });
    const refused = await callTool(endpoints, "show_card", { text: "No title" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("title");
    expect(items()).toEqual([]);
  });

  test("an item in the tab carries its count, kept up to date", async () => {
    const { endpoints, items } = await setUp();
    await callTool(endpoints, "track_steps", { title: "Release", steps: ["Build", "Ship"] });
    expect(items()[0]).toMatchObject({ type: "steps", icon: "◔", placement: "tab", count: "0/2" });
    await callTool(endpoints, "finish_step", {});
    expect(items()[0]).toMatchObject({ count: "1/2" });
  });

  test("the user's action reaches the plugin and its reply comes back; the agent hears of it with the next message, once", async () => {
    const { plugins, endpoints, items } = await setUp();
    await callTool(endpoints, "show_card", { title: "Hello", text: "First" });
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

  test("the user dismisses an item in the tab, and its plugin knows; a page can't be dismissed", async () => {
    const { plugins, endpoints, items } = await setUp();
    await callTool(endpoints, "track_steps", { title: "Release", steps: ["Build"] });
    await callTool(endpoints, "show_card", { title: "Hello", text: "First" });
    const [steps, card] = items();
    plugins.dismiss(steps!.id);
    expect(items()[0]).toMatchObject({ dismissed: true });
    expect(await callTool(endpoints, "finish_step", {})).toEqual({ text: "There are no steps to tick off.", isError: true });
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
      "the canvas host module needs items.card with an icon, a placement of page or tab, and count only as a function; tools named in lower case, digits and underscores, not Show-Card; tools.Show-Card with a description, an input schema and a run function; note only as a function",
    ]);
  });
});
