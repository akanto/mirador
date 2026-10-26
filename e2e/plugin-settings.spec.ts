import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openSettings, signIn } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost();
const counterRepo = () => join(host.root, "counter-repo");

const git = (folder: string, ...args: string[]) =>
  execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" }).trim();

/** The counter app the unit tests use, cloned from a repo of its own into the plugins folder, next to a plugin whose build never ran. */
function installPlugins() {
  cpSync(join(import.meta.dirname, "..", "tests", "fixtures", "apps", "counter"), counterRepo(), { recursive: true });
  git(counterRepo(), "init", "--quiet", "-b", "main");
  git(counterRepo(), "add", ".");
  git(counterRepo(), "commit", "--quiet", "-m", "Count by one");
  const plugins = join(host.dataDir, "plugins");
  mkdirSync(join(plugins, "unbuilt"), { recursive: true });
  git(plugins, "clone", "--quiet", counterRepo(), "counter");
  writeFileSync(join(plugins, "unbuilt", "plugin.json"), JSON.stringify({ name: "unbuilt", title: "Unbuilt", version: "1.0.0", api: 1, app: { host: "host.ts", view: "dist/view.js" } }));
}

test.beforeAll(async () => {
  installPlugins();
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("Settings lists the installed plugins, where each came from, and why one didn't load", async ({ page }) => {
  await signIn(page, host);
  const settings = await openSettings(page, "Plugins");
  const plugins = settings.getByRole("list", { name: "Plugins" }).getByRole("listitem");
  await expect(plugins).toHaveCount(2);
  await expect(plugins.nth(0)).toHaveText(`Countercounter1.0.0${counterRepo()} · main · ${git(counterRepo(), "rev-parse", "--short", "HEAD")} Count by oneCheck for updatesRemove`);
  await expect(plugins.nth(1)).toHaveText("Unbuiltunbuilt1.0.0A folder put there by handDidn't load: host.ts doesn't exist; build the plugin first?Remove");
  await expect(settings.getByText(join(host.dataDir, "plugins"), { exact: true })).toBeVisible();
  await expect(settings.getByText("a linked folder is your own checkout, so you update it there.", { exact: false })).toBeVisible();
});
