import { createHash } from "node:crypto";
import { existsSync, readdirSync, watch } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { APP_PLUGIN_API, CANVAS_PLUGIN_API, isPluginManifest, type AppHost, type AppTask, type InstalledApp, type PluginManifest } from "../../shared/apps.ts";
import { pluginItemPlacements, type CanvasHost } from "../../shared/canvas-plugins.ts";
import { BUILT_IN_CANVAS_TOOLS } from "../canvas/tool-names.ts";

/** Held in memory, so the code served under a hash is always the code that hash was made from. */
export interface ViewCode {
  code: Uint8Array<ArrayBuffer>;
  hash: string;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  folder: string;
  /** In Mirador's own plugins folder, rather than one the owner installed. */
  shipped: boolean;
}

/** A plugin's app part. */
export interface AppPlugin extends LoadedPlugin {
  host: AppHost;
  view: ViewCode;
}

/** A plugin's canvas part. */
export interface CanvasPlugin extends LoadedPlugin {
  host: CanvasHost;
  view: ViewCode;
}

export interface PluginLoadProblem {
  folder: string;
  message: string;
}

/** Thrown with a message for whoever asked: the agent as a tool error, or the user. */
export class AppProblem extends Error {}

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const HOST_FUNCTIONS = ["parse", "serialize", "apply", "describe"] as const;

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

export const appViewPath = (plugin: AppPlugin) => `/apps/${plugin.manifest.name}/${plugin.view.hash}/view.js`;

export const canvasViewPath = (plugin: CanvasPlugin) => `/apps/${plugin.manifest.name}/${plugin.view.hash}/canvas.js`;

export const installedApp = (plugin: AppPlugin): InstalledApp => ({
  name: plugin.manifest.name,
  title: plugin.manifest.title,
  viewPath: appViewPath(plugin),
});

/** The folders, or links to folders, in `pluginsFolder` that hold a plugin.json. */
export function pluginFolders(pluginsFolder: string): string[] {
  if (!existsSync(pluginsFolder)) return [];
  return readdirSync(pluginsFolder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join(pluginsFolder, entry.name))
    .filter((folder) => existsSync(join(folder, "plugin.json")))
    .sort();
}

export interface LoadedPlugins {
  apps: AppPlugin[];
  canvases: CanvasPlugin[];
  problems: PluginLoadProblem[];
}

/**
 * The plugins in Mirador's own `shippedFolder`, then every folder in `pluginsFolder` with a plugin.json; one that fails
 * to load is reported and the rest still load.
 */
export async function loadPlugins(pluginsFolder: string, shippedFolder: string | null = null): Promise<LoadedPlugins> {
  const loaded: LoadedPlugins = { apps: [], canvases: [], problems: [] };
  const names = new Map<string, LoadedPlugin>();
  const foldersToLoad = [
    ...(shippedFolder ? pluginFolders(shippedFolder).map((folder) => ({ folder, shipped: true })) : []),
    ...pluginFolders(pluginsFolder).map((folder) => ({ folder, shipped: false })),
  ];
  for (const { folder, shipped } of foldersToLoad) {
    try {
      const { app, canvas } = await loadPlugin(folder, shipped);
      const { name } = (app ?? canvas)!.manifest;
      const namesake = names.get(name);
      if (namesake) throw new Error(namesake.shipped ? `Mirador comes with a plugin named ${name}` : `another plugin is already named ${name}`);
      if (canvas) refuseTakenToolNames(canvas, loaded.canvases);
      names.set(name, (app ?? canvas)!);
      if (app) loaded.apps.push(app);
      if (canvas) loaded.canvases.push(canvas);
    } catch (error) {
      loaded.problems.push({ folder, message: messageOf(error) });
    }
  }
  return loaded;
}

function refuseTakenToolNames(plugin: CanvasPlugin, loadedBefore: CanvasPlugin[]) {
  for (const tool of Object.keys(plugin.host.tools)) {
    if (BUILT_IN_CANVAS_TOOLS.includes(tool)) throw new Error(`its tool ${tool} has the name of one of Mirador's own canvas tools`);
    const other = loadedBefore.find(({ host }) => Object.hasOwn(host.tools, tool));
    if (other) throw new Error(`its tool ${tool} has the name of a tool of ${other.manifest.name}`);
  }
}

/** The folder's plugin.json, held to what this Mirador loads; throws what is wrong with it. */
export async function readManifest(folder: string): Promise<PluginManifest> {
  const file = join(folder, "plugin.json");
  if (!existsSync(file)) throw new Error("there's no plugin.json at the top of its folder");
  const manifest: unknown = await Bun.file(file).json();
  if (!isPluginManifest(manifest)) {
    throw new Error("plugin.json needs a name (lower case, digits and dashes), a title, an api number, and app.host and app.view, canvas.host and canvas.view, or both");
  }
  if (!Number.isInteger(manifest.api) || manifest.api < 1 || manifest.api > APP_PLUGIN_API) {
    throw new Error(`plugin.json is for plugin API ${manifest.api}; this Mirador speaks plugin API 1 to ${APP_PLUGIN_API}, so the plugin needs a newer Mirador`);
  }
  if (manifest.canvas && manifest.api < CANVAS_PLUGIN_API) throw new Error(`plugin.json has a canvas part, which plugin API ${CANVAS_PLUGIN_API} brought; it names API ${manifest.api}`);
  return manifest;
}

/** The host and view files plugin.json names, by part; throws when one is missing or outside the folder. */
export function pluginFiles(folder: string, { app, canvas }: PluginManifest) {
  const filesOf = (part: { host: string; view: string }) => ({ hostFile: insideFolder(folder, part.host), viewFile: insideFolder(folder, part.view) });
  return { app: app && filesOf(app), canvas: canvas && filesOf(canvas) };
}

async function loadPlugin(folder: string, shipped: boolean): Promise<{ app: AppPlugin | null; canvas: CanvasPlugin | null }> {
  const manifest = await readManifest(folder);
  const files = pluginFiles(folder, manifest);
  const loaded = { manifest, folder, shipped };
  return {
    app: files.app ? { ...loaded, host: hostFrom(await import(files.app.hostFile)), view: await viewCode(files.app.viewFile, shipped) } : null,
    canvas: files.canvas ? { ...loaded, host: canvasHostFrom(await import(files.canvas.hostFile)), view: await viewCode(files.canvas.viewFile, shipped) } : null,
  };
}

const VIEW_SETTLES_MS = 100;

/**
 * Follows the views of the plugins the owner installed: a view built again is read again under its new hash, and
 * `onChange` hears of it, for the pages to load it. Mirador's own plugins are left out: their views are bundled from
 * sources that a change of one file doesn't cover. Each view's folder is watched rather than the file, which a build
 * may replace. Returns the function that stops it.
 */
export function watchViews({ apps, canvases }: Pick<LoadedPlugins, "apps" | "canvases">, onChange: () => void): () => void {
  const installed = (plugin: LoadedPlugin) => !plugin.shipped;
  const views = [
    ...apps.filter(installed).map((plugin) => ({ plugin, viewFile: pluginFiles(plugin.folder, plugin.manifest).app!.viewFile })),
    ...canvases.filter(installed).map((plugin) => ({ plugin, viewFile: pluginFiles(plugin.folder, plugin.manifest).canvas!.viewFile })),
  ];
  const timers = new Set<Timer>();
  const watchers = views.map(({ plugin, viewFile }) => {
    let settling: Timer | undefined;
    const readAgain = async () => {
      timers.delete(settling!);
      const view = await viewCode(viewFile, false).catch(() => null);
      if (!view || view.hash === plugin.view.hash) return;
      plugin.view = view;
      onChange();
    };
    const settle = (_event: string, file: string | null) => {
      if (file !== basename(viewFile)) return;
      clearTimeout(settling);
      timers.delete(settling!);
      settling = setTimeout(readAgain, VIEW_SETTLES_MS);
      timers.add(settling);
    };
    try {
      return watch(dirname(viewFile), settle);
    } catch (error) {
      console.warn(`A new build of ${viewFile} shows only after a restart: ${messageOf(error)}`);
      return null;
    }
  });
  return () => {
    for (const watcher of watchers) watcher?.close();
    for (const timer of timers) clearTimeout(timer);
  };
}

async function viewCode(viewFile: string, shipped: boolean): Promise<ViewCode> {
  const code = shipped ? await bundledView(viewFile) : await Bun.file(viewFile).bytes();
  return { code, hash: createHash("sha256").update(code).digest("hex").slice(0, 16) };
}

/** A shipped plugin has no build step of its own, so its view is bundled into one module here, as Bun bundles the page. */
async function bundledView(viewFile: string): Promise<Uint8Array<ArrayBuffer>> {
  const built = await Bun.build({ entrypoints: [viewFile], minify: true, define: { "process.env.NODE_ENV": JSON.stringify("production") }, throw: false });
  const bundle = built.outputs.find((output) => output.kind === "entry-point");
  if (!built.success || !bundle) throw new Error(`its view didn't bundle: ${built.logs.map(String).join("; ")}`);
  return new Uint8Array(await bundle.arrayBuffer());
}

function insideFolder(folder: string, relativePath: string) {
  const file = resolve(folder, relativePath);
  if (!file.startsWith(resolve(folder) + sep)) throw new Error(`${relativePath} is outside the plugin's folder`);
  if (!existsSync(file)) throw new Error(`${relativePath} doesn't exist; build the plugin first?`);
  return file;
}

const exportsOf = (module: Record<string, unknown>) => (typeof module.default === "object" && module.default !== null ? module.default : module) as Record<string, unknown>;

function hostFrom(module: Record<string, unknown>): AppHost {
  const host = exportsOf(module);
  const missing = HOST_FUNCTIONS.filter((name) => typeof host[name] !== "function");
  if (missing.length > 0) throw new Error(`the host module doesn't export ${missing.join(", ")}`);
  const unusableTasks = Object.entries((host.tasks ?? {}) as Record<string, Partial<AppTask> | null>)
    .filter(([, task]) => typeof task?.title !== "string" || typeof task.run !== "function")
    .map(([name]) => name);
  if (unusableTasks.length > 0) throw new Error(`the host module's tasks ${unusableTasks.join(", ")} need a title and a run function`);
  return host as unknown as AppHost;
}

const isFunction = (value: unknown) => typeof value === "function";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function canvasHostFrom(module: Record<string, unknown>): CanvasHost {
  const host = exportsOf(module);
  const problems: string[] = [];
  if (!isObject(host.items)) problems.push("items, by name");
  if (!isObject(host.tools)) problems.push("tools, by name");
  const items = isObject(host.items) ? host.items : {};
  const tools = isObject(host.tools) ? host.tools : {};
  for (const [name, item] of Object.entries(items)) {
    const { icon, placement, opensWithRoom, ...functions } = (isObject(item) ? item : {}) as Record<string, unknown>;
    const optionalFunctions = (["count", "outcome", "listed"] as const).map((key) => functions[key]);
    if (typeof icon !== "string" || !pluginItemPlacements.includes(placement as never) || optionalFunctions.some((value) => value !== undefined && !isFunction(value))) {
      problems.push(`items.${name} with an icon, a placement of ${pluginItemPlacements.join(" or ")}, and count, outcome and listed only as functions`);
    }
    if (opensWithRoom !== undefined && typeof opensWithRoom !== "boolean") problems.push(`items.${name} with opensWithRoom only as true or false`);
  }
  for (const [name, tool] of Object.entries(tools)) {
    const { description, input, run } = (isObject(tool) ? tool : {}) as Record<string, unknown>;
    if (!TOOL_NAME.test(name)) problems.push(`tools named in lower case, digits and underscores, not ${name}`);
    if (typeof description !== "string" || !isObject(input) || !isFunction(run)) problems.push(`tools.${name} with a description, an input schema and a run function`);
  }
  if (host.action !== undefined && !isFunction(host.action)) problems.push("action only as a function");
  if (host.note !== undefined && !isFunction(host.note)) problems.push("note only as a function");
  if (problems.length > 0) throw new Error(`the canvas host module needs ${problems.join("; ")}`);
  return host as unknown as CanvasHost;
}
