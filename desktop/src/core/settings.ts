import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DesktopSettings {
  hostDirectory: string;
  bun: string;
  hostRunsInBackground: boolean;
  openAtLogin: boolean;
}

export type BuildDefaults = Pick<DesktopSettings, "hostDirectory" | "bun">;

export const defaultSettings = (build: BuildDefaults): DesktopSettings => ({
  ...build,
  hostRunsInBackground: false,
  openAtLogin: true,
});

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

export function parseSettings(text: string, defaults: DesktopSettings): DesktopSettings {
  const stored = (() => {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  })();
  return {
    hostDirectory: isNonEmptyString(stored.hostDirectory) ? stored.hostDirectory : defaults.hostDirectory,
    bun: isNonEmptyString(stored.bun) ? stored.bun : defaults.bun,
    hostRunsInBackground: typeof stored.hostRunsInBackground === "boolean" ? stored.hostRunsInBackground : defaults.hostRunsInBackground,
    openAtLogin: typeof stored.openAtLogin === "boolean" ? stored.openAtLogin : defaults.openAtLogin,
  };
}

export function saveSettings(file: string, settings: DesktopSettings) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function readIfPresent(file: string) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The first launch writes the defaults out so the file is there to edit. */
export function loadSettings(file: string, build: BuildDefaults): DesktopSettings {
  const defaults = defaultSettings(build);
  const text = readIfPresent(file);
  if (text === null) {
    saveSettings(file, defaults);
    return defaults;
  }
  return parseSettings(text, defaults);
}

export class SettingsStore {
  private settings: DesktopSettings;

  constructor(private readonly file: string, build: BuildDefaults) {
    this.settings = loadSettings(file, build);
  }

  current() {
    return this.settings;
  }

  update(patch: Partial<DesktopSettings>) {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.file, this.settings);
    return this.settings;
  }
}
