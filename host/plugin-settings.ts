import type { PluginManifest, PluginSettings } from "../shared/apps.ts";
import type { Store } from "./store.ts";

/** The settings the loaded plugins declare, with the values the user chose, which Mirador keeps for every browser. */
export class PluginSettingsStore {
  constructor(
    private readonly store: Store,
    private readonly manifests: PluginManifest[],
  ) {}

  all(): PluginSettings[] {
    const chosen = this.store.listPluginSettings();
    return this.withSettings().map(({ name, settings }) => ({ plugin: name, settings: settings!, chosen: chosen[name] ?? {} }));
  }

  /** Keeps one of the setting's own choices; throws for anything else. */
  choose(plugin: string, settingId: string, value: string) {
    const setting = this.withSettings()
      .find(({ name }) => name === plugin)
      ?.settings!.find(({ id }) => id === settingId);
    if (!setting) throw new Error(`${plugin} has no setting ${settingId}.`);
    if (!setting.choices.some((choice) => choice.value === value)) throw new Error(`${value} is not one of the choices of ${setting.label}.`);
    this.store.savePluginSetting(plugin, settingId, value);
  }

  private withSettings() {
    const seen = new Set<string>();
    return this.manifests.filter(({ name, settings }) => settings && settings.length > 0 && !seen.has(name) && seen.add(name));
  }
}
