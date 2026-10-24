import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { APP_PLUGIN_API, isAppManifest, type AppHost, type AppManifest, type AppTask, type InstalledApp } from "../../shared/apps.ts";

export interface AppPlugin {
  manifest: AppManifest;
  folder: string;
  /** In Mirador's own plugins folder, rather than one the owner installed. */
  shipped: boolean;
  host: AppHost;
  /** Held in memory, so the code served under a hash is always the code that hash was made from. */
  view: { code: Uint8Array<ArrayBuffer>; hash: string };
}

export interface PluginLoadProblem {
  folder: string;
  message: string;
}

/** Thrown with a message for whoever asked: the agent as a tool error, or the user. */
export class AppProblem extends Error {}

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const HOST_FUNCTIONS = ["parse", "serialize", "apply", "describe"] as const;

export const appViewPath = (plugin: AppPlugin) => `/apps/${plugin.manifest.name}/${plugin.view.hash}/view.js`;

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

/**
 * The plugins in Mirador's own `shippedFolder`, then every folder in `pluginsFolder` with a plugin.json that brings an
 * app; one that fails to load is reported and the rest still load.
 */
export async function loadAppPlugins(pluginsFolder: string, shippedFolder: string | null = null): Promise<{ plugins: AppPlugin[]; problems: PluginLoadProblem[] }> {
  const plugins: AppPlugin[] = [];
  const problems: PluginLoadProblem[] = [];
  const foldersToLoad = [
    ...(shippedFolder ? pluginFolders(shippedFolder).map((folder) => ({ folder, shipped: true })) : []),
    ...pluginFolders(pluginsFolder).map((folder) => ({ folder, shipped: false })),
  ];
  for (const { folder, shipped } of foldersToLoad) {
    try {
      const plugin = await loadAppPlugin(folder, shipped);
      const namesake = plugins.find(({ manifest }) => manifest.name === plugin.manifest.name);
      if (namesake) throw new Error(namesake.shipped ? `Mirador comes with a plugin named ${plugin.manifest.name}` : `another plugin is already named ${plugin.manifest.name}`);
      plugins.push(plugin);
    } catch (error) {
      problems.push({ folder, message: messageOf(error) });
    }
  }
  return { plugins, problems };
}

/** The folder's plugin.json, held to what this Mirador loads; throws what is wrong with it. */
export async function readManifest(folder: string): Promise<AppManifest> {
  const file = join(folder, "plugin.json");
  if (!existsSync(file)) throw new Error("there's no plugin.json at the top of its folder");
  const manifest: unknown = await Bun.file(file).json();
  if (!isAppManifest(manifest)) throw new Error("plugin.json needs a name (lower case, digits and dashes), a title, an api number and app.host and app.view");
  if (!Number.isInteger(manifest.api) || manifest.api < 1 || manifest.api > APP_PLUGIN_API) {
    throw new Error(`plugin.json is for plugin API ${manifest.api}; this Mirador speaks plugin API 1 to ${APP_PLUGIN_API}, so the plugin needs a newer Mirador`);
  }
  return manifest;
}

/** The host and view files plugin.json names; throws when one is missing or outside the folder. */
export function pluginFiles(folder: string, manifest: AppManifest) {
  return { hostFile: insideFolder(folder, manifest.app.host), viewFile: insideFolder(folder, manifest.app.view) };
}

async function loadAppPlugin(folder: string, shipped: boolean): Promise<AppPlugin> {
  const manifest = await readManifest(folder);
  const { hostFile, viewFile } = pluginFiles(folder, manifest);
  const host = hostFrom(await import(hostFile));
  const code = shipped ? await bundledView(viewFile) : await Bun.file(viewFile).bytes();
  return { manifest, folder, shipped, host, view: { code, hash: createHash("sha256").update(code).digest("hex").slice(0, 16) } };
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

function hostFrom(module: Record<string, unknown>): AppHost {
  const host = (typeof module.default === "object" && module.default !== null ? module.default : module) as Record<string, unknown>;
  const missing = HOST_FUNCTIONS.filter((name) => typeof host[name] !== "function");
  if (missing.length > 0) throw new Error(`the host module doesn't export ${missing.join(", ")}`);
  const unusableTasks = Object.entries((host.tasks ?? {}) as Record<string, Partial<AppTask> | null>)
    .filter(([, task]) => typeof task?.title !== "string" || typeof task.run !== "function")
    .map(([name]) => name);
  if (unusableTasks.length > 0) throw new Error(`the host module's tasks ${unusableTasks.join(", ")} need a title and a run function`);
  return host as unknown as AppHost;
}
