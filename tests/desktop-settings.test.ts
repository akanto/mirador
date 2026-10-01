import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings, loadSettings, parseSettings, SettingsStore } from "../desktop/src/core/settings.ts";

const build = { hostDirectory: "/repo", bun: "/bin/bun" };
const directories: string[] = [];

function scratchFile() {
  const directory = mkdtempSync(join(tmpdir(), "mirador-desktop-"));
  directories.push(directory);
  return join(directory, "nested", "desktop.json");
}

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("desktop settings", () => {
  test("default to hosting from the repo with the build's bun, in the foreground, opening at login", () => {
    expect(defaultSettings(build)).toEqual({ hostDirectory: "/repo", bun: "/bin/bun", hostRunsInBackground: false, openAtLogin: true });
  });

  test("keep valid stored values and fall back per field for the rest", () => {
    const defaults = defaultSettings(build);
    const stored = JSON.stringify({ hostDirectory: "/elsewhere", bun: "", hostRunsInBackground: "yes", openAtLogin: false });
    expect(parseSettings(stored, defaults)).toEqual({ hostDirectory: "/elsewhere", bun: "/bin/bun", hostRunsInBackground: false, openAtLogin: false });
  });

  test("fall back to the defaults for text that is not a JSON object", () => {
    const defaults = defaultSettings(build);
    expect(parseSettings("{oops", defaults)).toEqual(defaults);
    expect(parseSettings("null", defaults)).toEqual(defaults);
    expect(parseSettings("[1]", defaults)).toEqual(defaults);
  });

  test("the first load writes the defaults for the user to edit", () => {
    const file = scratchFile();
    expect(loadSettings(file, build)).toEqual(defaultSettings(build));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(defaultSettings(build));
  });

  test("a later load reads what the user edited", () => {
    const file = scratchFile();
    loadSettings(file, build);
    writeFileSync(file, JSON.stringify({ ...defaultSettings(build), hostDirectory: "/mine" }));
    expect(loadSettings(file, build).hostDirectory).toBe("/mine");
  });

  test("the store persists each update", () => {
    const file = scratchFile();
    const store = new SettingsStore(file, build);
    store.update({ hostRunsInBackground: true });
    expect(store.current().hostRunsInBackground).toBe(true);
    expect(new SettingsStore(file, build).current().hostRunsInBackground).toBe(true);
  });
});
