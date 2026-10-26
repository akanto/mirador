import { catalogPluginsOf, type CatalogPlugin } from "../shared/apps.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { withoutCredentials, type InstalledPlugins } from "./apps/installed-plugins.ts";
import { messageOf } from "./apps/plugins.ts";
import type { Store } from "./store.ts";

const GIVE_UP_AFTER_MILLISECONDS = 20_000;

/** The official plugins, as the catalog lists them; the last one fetched stands while Mirador can't fetch it. */
export class PluginCatalog {
  private plugins: CatalogPlugin[];

  constructor(
    private readonly store: Store,
    private readonly url: string | null,
    private readonly isInstalled: (name: string) => boolean,
  ) {
    this.plugins = catalogPluginsOf(store.pluginCatalog()) ?? [];
  }

  get all(): CatalogPlugin[] {
    return this.plugins;
  }

  /** The ones the user could install: not in the plugins folder yet. */
  notInstalled(): CatalogPlugin[] {
    return this.plugins.filter(({ name }) => !this.isInstalled(name));
  }

  /** Throws why the plugin can't be installed from the catalog. */
  installable(name: string): CatalogPlugin {
    const plugin = this.plugins.find((listed) => listed.name === name);
    if (!plugin) throw new Error(`${name} is not an official plugin; they are ${this.plugins.map((listed) => listed.name).join(", ") || "not known yet"}.`);
    if (this.isInstalled(name)) throw new Error(`${plugin.title} is installed already.`);
    return plugin;
  }

  /** Fetches the catalog; a failure keeps the last one and is only logged. */
  async refresh() {
    if (!this.url) return;
    try {
      const response = await fetch(this.url, { signal: AbortSignal.timeout(GIVE_UP_AFTER_MILLISECONDS) });
      if (!response.ok) throw new Error(`it answered ${response.status}`);
      const catalog: unknown = await response.json();
      const plugins = catalogPluginsOf(catalog);
      if (!plugins) throw new Error("it lists no plugins");
      this.plugins = plugins;
      this.store.savePluginCatalog(catalog);
    } catch (error) {
      console.warn(`${new Date().toISOString()} the catalog of official plugins at ${this.url} couldn't be fetched: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export const pluginsListed = async (plugins: InstalledPlugins, catalog: PluginCatalog): Promise<ServerMessage> => ({
  type: "plugins.listed",
  folder: plugins.folder,
  plugins: await plugins.list(),
  official: catalog.all,
  restartNeeded: plugins.restartNeeded,
});

/** Installs an official plugin the user said yes to, and says what came of it in words for the agent. */
export async function installOfficialPlugin(name: string, catalog: PluginCatalog, plugins: InstalledPlugins, listed: (message: ServerMessage) => void) {
  try {
    const plugin = catalog.installable(name);
    await plugins.add(plugin.repo, plugin.branch ?? null);
    listed(await pluginsListed(plugins, catalog));
    return `Mirador installed the ${plugin.title} plugin and uses it from its next restart. Tell the user to restart Mirador to use it: ⌘⇧R, or Restart host in Settings → Plugins.`;
  } catch (error) {
    return `Installing the ${name} plugin failed: ${withoutCredentials(messageOf(error))}`;
  }
}
