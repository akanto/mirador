import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionMeta } from "../host/acp/harnesses.ts";
import { canvasInstructions, canvasUseGuidance } from "../host/canvas/guidance.ts";
import { pluginItemOfSavedTour, type SavedTour } from "../host/saved-tours.ts";
import { Store } from "../host/store.ts";
import type { CanvasItem, PluginCanvasItem } from "../shared/model.ts";
import type { Tour } from "../shared/review.ts";
import type { PlaceInWalkthrough } from "../web/walkthrough-host.ts";
import { canvasPluginHost, storeWithConversation } from "./canvas-plugin-host.ts";
import { gitRepository } from "./review-repository.ts";

const SHIPPED = join(import.meta.dir, "..", "plugins");
const NO_PLUGINS_OF_THE_OWNER = join(tmpdir(), "mirador-no-plugins-here");

const setUp = (store?: Store) => canvasPluginHost(NO_PLUGINS_OF_THE_OWNER, SHIPPED, store);

const place = (tab: PlaceInWalkthrough["tab"]): PlaceInWalkthrough => ({ tab, stepIndex: 1, path: null, hunkIndex: 0, findingId: null, answerId: null, scrolled: {} });

describe("the review plugin Mirador comes with: tours", () => {
  test("the tour tool is pre-allowed and offered up front, with its lines of guidance", async () => {
    const { plugins, mcpRequest } = await setUp();
    const { tools } = await mcpRequest("tools/list", {});
    expect(tools.find(({ name }: { name: string }) => name === "tour")).toMatchObject({ _meta: { "anthropic/alwaysLoad": true } });
    expect(claudeSessionMeta("often", { canvasPlugins: plugins.guidance }).claudeCode.options.allowedTools).toContain("mcp__canvas__tour");
    expect(canvasInstructions("http://127.0.0.1:4601", plugins.guidance)).toContain("\n- tour: when you explain how code works,");
    expect(canvasUseGuidance(plugins.guidance)).toContain("\n- tour: explaining how code works,");
  });

  test("a tour is the plugin's item, and a changed file reads as it was when the tour was published, not as it is now", async () => {
    const { callTool, items, plugins } = await setUp();
    const { directory } = gitRepository();
    writeFileSync(join(directory, "service.ts"), "export function serve() {\n  return load() + 2;\n}\n");

    const shown = await callTool("tour", { title: "Serve", folder: directory, since: "main", summary: "Adds two.", flow: [{ title: "Entry", at: "service.ts:2", say: "Adds." }] });
    writeFileSync(join(directory, "service.ts"), "changed again\n");

    const [tour] = items();
    expect(shown).toEqual({ text: `Shown to the user as tour ${tour!.id}: 1 flow steps, 1 files changed since main.`, isError: false });
    expect(tour).toMatchObject({ kind: "plugin", plugin: "review", type: "tour", icon: "↯", placement: "page", title: "Serve" });
    expect((tour!.data as Tour).files.map(({ path }) => path)).toEqual(["service.ts"]);
    expect(await plugins.act(tour!.id, { kind: "read-file", path: "service.ts" })).toEqual(["export function serve() {", "  return load() + 2;", "}"]);
    await expect(plugins.act(tour!.id, { kind: "read-file", path: "other.ts" })).rejects.toThrow("other.ts is not a file this tour shows changes of.");
  });

  test("wrong anchors all go back to the agent, and nothing is shown", async () => {
    const { callTool, items } = await setUp();
    const { directory } = gitRepository();
    const refused = await callTool("tour", { title: "Nowhere", folder: directory, summary: "?", flow: [{ title: "Nowhere", at: "service.ts:99", say: "?" }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("The tour was not shown.");
    expect(refused.text).toContain("service.ts:99 is outside the file");
    expect(items()).toEqual([]);
  });

  test("the view's pane shares and the place left in each tour are kept", async () => {
    const { callTool, plugins, items } = await setUp();
    const { directory } = gitRepository();
    const tour = { title: "Serve", folder: directory, summary: "s", flow: [{ title: "Entry", at: "service.ts:2", say: "Adds." }] };
    await callTool("tour", tour);
    await callTool("tour", tour);
    const [first, second] = items();
    expect(await plugins.act(first!.id, { kind: "recall" })).toEqual({ paneShares: null, place: null });

    await plugins.act(first!.id, { kind: "remember-pane-shares", shares: { listShare: 0.3, bandShare: 0.4 } });
    await plugins.act(first!.id, { kind: "leave-place", place: place("flow") });
    await plugins.act(second!.id, { kind: "leave-place", place: place("files") });
    expect(await plugins.act(first!.id, { kind: "recall" })).toEqual({ paneShares: { listShare: 0.3, bandShare: 0.4 }, place: place("flow") });
    expect(await plugins.act(second!.id, { kind: "recall" })).toMatchObject({ place: { tab: "files" } });

  });
});

const savedTour: SavedTour = {
  id: "saved-tour",
  conversationId: "c1",
  kind: "tour",
  title: "How it serves",
  status: "shown",
  createdAt: 5,
  tour: { folder: "/tmp/p", changes: null, summary: "Serves.", flow: [{ title: "Entry", at: { path: "a.ts", line: 1, endLine: 1 }, say: "Starts.", excerpt: [] }], files: [] } as unknown as Tour,
};

describe("tours saved before tours came from the review plugin", () => {
  test("become the plugin's items, as they were, changed now", () => {
    expect(pluginItemOfSavedTour(savedTour, 100)).toEqual({
      id: "saved-tour",
      conversationId: "c1",
      kind: "plugin",
      plugin: "review",
      type: "tour",
      icon: "↯",
      placement: "page",
      title: "How it serves",
      status: "shown",
      createdAt: 5,
      updatedAt: 100,
      data: savedTour.tour,
    });
  });

  test("are handed to the plugin when Mirador opens its database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "saved-tours-")), "state.sqlite");
    const before = storeWithConversation(path);
    before.saveCanvasItem(savedTour as unknown as CanvasItem);
    before.close();
    const opened = new Store(path);
    expect(opened.listCanvasItems("c1") as PluginCanvasItem[]).toMatchObject([{ id: "saved-tour", kind: "plugin", plugin: "review", type: "tour", data: savedTour.tour }]);
  });
});
