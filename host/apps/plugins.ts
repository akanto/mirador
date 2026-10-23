import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { APP_PLUGIN_API, isAppManifest, type AppHost, type AppManifest, type InstalledApp } from "../../shared/apps.ts";

export interface AppPlugin {
  manifest: AppManifest;
  folder: string;
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

/** Every folder in `pluginsFolder` with a plugin.json that brings an app; one that fails to load is reported and the rest still load. */
export async function loadAppPlugins(pluginsFolder: string): Promise<{ plugins: AppPlugin[]; problems: PluginLoadProblem[] }> {
  const plugins: AppPlugin[] = [];
  const problems: PluginLoadProblem[] = [];
  for (const folder of pluginFolders(pluginsFolder)) {
    try {
      const plugin = await loadAppPlugin(folder);
      if (plugins.some(({ manifest }) => manifest.name === plugin.manifest.name)) throw new Error(`another plugin is already named ${plugin.manifest.name}`);
      plugins.push(plugin);
    } catch (error) {
      problems.push({ folder, message: messageOf(error) });
    }
  }
  return { plugins, problems };
}

async function loadAppPlugin(folder: string): Promise<AppPlugin> {
  const manifest: unknown = await Bun.file(join(folder, "plugin.json")).json();
  if (!isAppManifest(manifest)) throw new Error("plugin.json needs a name (lower case, digits and dashes), a title, an api number and app.host and app.view");
  if (manifest.api !== APP_PLUGIN_API) throw new Error(`plugin.json is for plugin API ${manifest.api}; this Mirador speaks ${APP_PLUGIN_API}`);
  const hostFile = insideFolder(folder, manifest.app.host);
  const viewFile = insideFolder(folder, manifest.app.view);
  const host = hostFrom(await import(hostFile));
  const code = await Bun.file(viewFile).bytes();
  return { manifest, folder, host, view: { code, hash: createHash("sha256").update(code).digest("hex").slice(0, 16) } };
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
  return host as unknown as AppHost;
}
