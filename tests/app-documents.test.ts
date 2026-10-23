import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDocuments, type AppPublisher } from "../host/apps/documents.ts";
import { AppProblem, loadAppPlugins } from "../host/apps/plugins.ts";
import { Store } from "../host/store.ts";
import { appPromptText, type AppDocumentState, type OpenApp } from "../shared/apps.ts";

const FIXTURE_APPS = join(import.meta.dir, "fixtures", "apps");

function recordingPublisher() {
  const states: AppDocumentState[] = [];
  const openAppLists: OpenApp[][] = [];
  const publisher: AppPublisher = { openAppsChanged: (openApps) => openAppLists.push(openApps), stateChanged: (state) => states.push(state) };
  return { publisher, states, openAppLists };
}

async function setUp(store = new Store(":memory:"), workspacePath = mkdtempSync(join(tmpdir(), "app-workspace-"))) {
  if (!store.findWorkspace("w1")) store.insertWorkspace({ id: "w1", name: "p", path: workspacePath, defaultLaunch: { harness: "claude", profileId: null }, createdAt: 1 });
  const { plugins } = await loadAppPlugins(FIXTURE_APPS);
  const recorded = recordingPublisher();
  const apps = new AppDocuments(store, plugins, recorded.publisher);
  const fileText = () => readFileSync(join(workspacePath, "counter.json"), "utf8");
  return { store, workspacePath, apps, fileText, ...recorded };
}

async function eventually(check: () => void, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(25);
    }
  }
}

/** Longer than the watcher's settling time, so an edit it should ignore has had its chance to show. */
const watcherHadItsChance = () => Bun.sleep(500);

function pluginFolder(files: Record<string, string>) {
  const folder = mkdtempSync(join(tmpdir(), "plugins-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  return folder;
}

describe("loadAppPlugins", () => {
  test("loads an app plugin and serves its view under a hash of its code", async () => {
    const { plugins, problems } = await loadAppPlugins(FIXTURE_APPS);
    expect(problems).toEqual([]);
    const { apps } = await setUp();
    const [counter] = apps.installed();
    expect(counter).toMatchObject({ name: "counter", title: "Counter" });
    expect(counter!.viewPath).toMatch(/^\/apps\/counter\/[0-9a-f]{16}\/view\.js$/);
    expect(new TextDecoder().decode(apps.viewCode(counter!.viewPath)!)).toContain("window.mirador.onState");
    expect(apps.viewCode("/apps/counter/0000000000000000/view.js")).toBeNull();
    expect(plugins).toHaveLength(1);
  });

  test("reports a plugin that fails to load and still loads the others", async () => {
    const folder = pluginFolder({
      "broken-json/plugin.json": "{",
      "old-api/plugin.json": JSON.stringify({ name: "old-api", title: "Old", api: 99, app: { host: "host.ts", view: "view.js" } }),
      "no-exports/plugin.json": JSON.stringify({ name: "no-exports", title: "None", api: 1, app: { host: "host.ts", view: "view.js" } }),
      "no-exports/host.ts": "export const parse = () => 1;",
      "no-exports/view.js": "",
      "unbuilt/plugin.json": JSON.stringify({ name: "unbuilt", title: "Unbuilt", api: 1, app: { host: "host.ts", view: "dist/view.js" } }),
      "unbuilt/host.ts": "export default {};",
      "escapes/plugin.json": JSON.stringify({ name: "escapes", title: "Escapes", api: 1, app: { host: "../outside.ts", view: "view.js" } }),
      "just-a-folder/readme.md": "not a plugin",
    });
    cpSync(join(FIXTURE_APPS, "counter"), join(folder, "counter"), { recursive: true });
    const { plugins, problems } = await loadAppPlugins(folder);
    expect(plugins.map(({ manifest }) => manifest.name)).toEqual(["counter"]);
    const problemOf = (name: string) => problems.find((problem) => problem.folder.endsWith(name))?.message;
    expect(problems).toHaveLength(5);
    expect(problemOf("old-api")).toContain("plugin API 99");
    expect(problemOf("no-exports")).toContain("serialize, apply, describe");
    expect(problemOf("unbuilt")).toContain("dist/view.js doesn't exist");
    expect(problemOf("escapes")).toContain("outside the plugin's folder");
  });

  test("finds nothing in a folder that doesn't exist", async () => {
    expect(await loadAppPlugins(join(tmpdir(), "no-such-plugins-folder"))).toEqual({ plugins: [], problems: [] });
  });
});

describe("AppDocuments", () => {
  test("opens an app on a new file, which it creates", async () => {
    const { apps, fileText, openAppLists, states } = await setUp();
    expect(await apps.open("w1", "counter", "counter.json")).toEqual({ workspaceId: "w1", app: "counter", title: "Counter", file: "counter.json" });
    expect(JSON.parse(fileText())).toEqual({ count: 0 });
    expect(openAppLists.at(-1)).toHaveLength(1);
    expect(states.at(-1)).toEqual({ workspaceId: "w1", app: "counter", document: { count: 0 }, lastChange: null, problem: null });
    apps.stop();
  });

  test("applies operations sent at once one after another, and the file holds them", async () => {
    const { apps, fileText } = await setUp();
    await apps.open("w1", "counter", "counter.json");
    const agent = { kind: "agent" as const, conversationId: "c1", turnSeq: 4 };
    const changes = await Promise.all([apps.apply("w1", undefined, { op: "add", by: 1 }, agent), apps.apply("w1", "counter", { op: "add", by: 2 }, { kind: "you" })]);
    expect(changes.map(({ seq, summary }) => [seq, summary])).toEqual([
      [1, "Added 1; the count is 1."],
      [2, "Added 2; the count is 3."],
    ]);
    expect(changes[0]!.author).toEqual(agent);
    expect(JSON.parse(fileText())).toEqual({ count: 3 });
    apps.stop();
  });

  test("leaves the document and the file as they were when the plugin refuses or throws", async () => {
    const { apps, fileText, states } = await setUp();
    await apps.open("w1", "counter", "counter.json");
    await apps.apply("w1", undefined, { op: "add", by: 5 }, { kind: "you" });
    const before = fileText();
    const statesBefore = states.length;
    expect(apps.apply("w1", undefined, { op: "multiply" }, { kind: "you" })).rejects.toThrow('use { op: "add", by: <number> }');
    expect(apps.apply("w1", undefined, { op: "crash" }, { kind: "you" })).rejects.toBeInstanceOf(AppProblem);
    await apps.apply("w1", undefined, { op: "add", by: 1 }, { kind: "you" }).catch(() => {});
    expect(JSON.parse(fileText())).toEqual({ count: 6 });
    expect(before).toBe('{\n  "count": 5\n}\n');
    expect(states.slice(statesBefore).map(({ document }) => document)).toEqual([{ count: 6 }]);
    apps.stop();
  });

  test("doesn't take its own writes for edits made outside, and does take an outside edit", async () => {
    const { apps, workspacePath, states } = await setUp();
    await apps.open("w1", "counter", "counter.json");
    await apps.apply("w1", undefined, { op: "add", by: 1 }, { kind: "you" });
    await watcherHadItsChance();
    expect(states.at(-1)!.lastChange!.author).toEqual({ kind: "you" });
    writeFileSync(join(workspacePath, "counter.json"), '{ "count": 10 }');
    await eventually(() => expect(states.at(-1)!.lastChange).toMatchObject({ seq: 2, author: { kind: "outside" }, summary: "Edited outside Mirador" }));
    expect(states.at(-1)!.document).toEqual({ count: 10 });
    expect(apps.describe("w1", undefined)).toContain("2. edited outside Mirador: Edited outside Mirador");
    apps.stop();
  });

  test("keeps the last good document while the file doesn't parse, and refuses operations until it does", async () => {
    const { apps, workspacePath, states } = await setUp();
    await apps.open("w1", "counter", "counter.json");
    await apps.apply("w1", undefined, { op: "add", by: 2 }, { kind: "you" });
    writeFileSync(join(workspacePath, "counter.json"), '{ "count": ');
    await eventually(() => expect(states.at(-1)!.problem).toBeTruthy());
    expect(states.at(-1)!.document).toEqual({ count: 2 });
    expect(apps.apply("w1", undefined, { op: "add", by: 1 }, { kind: "you" })).rejects.toThrow("counter.json can't be read");
    writeFileSync(join(workspacePath, "counter.json"), '{ "count": 7 }');
    await eventually(() => expect(states.at(-1)).toMatchObject({ problem: null, document: { count: 7 } }));
    apps.stop();
  });

  test("opens the same apps again when the host starts again", async () => {
    const first = await setUp();
    await first.apps.open("w1", "counter", "counter.json");
    await first.apps.apply("w1", undefined, { op: "add", by: 4 }, { kind: "you" });
    first.apps.stop();
    const second = await setUp(first.store, first.workspacePath);
    await second.apps.reopenAll();
    expect(second.apps.openApps()).toEqual([{ workspaceId: "w1", app: "counter", title: "Counter", file: "counter.json" }]);
    expect(second.apps.state("w1", "counter")!.document).toEqual({ count: 4 });
    second.apps.stop();
  });

  test("says what to do when no app or another app is asked for", async () => {
    const { apps } = await setUp();
    expect(() => apps.describe("w1", undefined)).toThrow("Open one with app_open; installed: counter.");
    expect(apps.open("w1", "sketchbook", "sketch.json")).rejects.toThrow("No app is called sketchbook. Installed: counter.");
    expect(apps.open("w1", "counter", "../elsewhere.json")).rejects.toThrow("is outside the workspace");
    await apps.open("w1", "counter", "counter.json");
    expect(() => apps.apply("w1", "sketchbook", { op: "add", by: 1 }, { kind: "you" })).toThrow("sketchbook isn't open in this workspace; open here: counter.");
    apps.stop();
  });

  test("describes the document in the plugin's words, with the latest changes", async () => {
    const { apps } = await setUp();
    await apps.open("w1", "counter", "counter.json");
    expect(apps.describe("w1", undefined)).toBe("Counter on counter.json\n\nThe count is 0.\n\nNo changes yet since Mirador started.");
    await apps.apply("w1", undefined, { op: "add", by: 3 }, { kind: "agent", conversationId: "c1", turnSeq: null });
    expect(apps.describe("w1", "counter")).toBe("Counter on counter.json\n\nThe count is 3.\n\nLatest changes:\n1. agent: Added 3; the count is 3.");
    apps.stop();
  });
});

describe("appPromptText", () => {
  test("names the app and its file before the user's words, so the agent knows what they are about", () => {
    const counter: OpenApp = { workspaceId: "w1", app: "counter", title: "Counter", file: "notes/counter.json" };
    expect(appPromptText(counter, "  Make it 10\n")).toBe("About notes/counter.json, open in Counter (app_state reads it, apply changes it):\n\nMake it 10");
  });
});
