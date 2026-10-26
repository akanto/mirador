import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, openSettings, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";
import { MIRADOR_VERSION } from "../shared/version.ts";

const host: TestHost = new TestHost({ fakePrograms: true, environment: () => ({ MIRADOR_PLUGIN_CATALOG: `file://${catalogFile()}` }) });
const catalogFile = () => join(host.root, "official-plugins.json");
const counterRepo = () => join(host.root, "counter-repo");
const tallyRepo = () => join(host.root, "tally-repo");

const git = (folder: string, ...args: string[]) =>
  execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" }).trim();

/** The counter app in a repo of its own, under `name`. */
function counterRepoNamed(folder: string, name: string) {
  cpSync(join(import.meta.dirname, "..", "tests", "fixtures", "apps", "counter"), folder, { recursive: true });
  const manifest = join(folder, "plugin.json");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace('"name": "counter"', `"name": "${name}"`));
  git(folder, "init", "--quiet", "-b", "main");
  git(folder, "add", ".");
  git(folder, "commit", "--quiet", "-m", "Count by one");
}

/** A catalog of two plugins with repos of their own, and of the checklist, which comes with Mirador. */
function publishCatalog() {
  counterRepoNamed(counterRepo(), "counter");
  counterRepoNamed(tallyRepo(), "tally");
  const counter = { name: "counter", title: "Counter", description: "Counts by one.", recommendWhen: "the user wants to count", repo: counterRepo(), branch: "main" };
  const tally = { name: "tally", title: "Tally", description: "Keeps a tally.", recommendWhen: "the user keeps a tally", repo: tallyRepo() };
  const checklist = { name: "checklist", title: "Checklist", description: "Steps, ticked.", recommendWhen: "the work has several steps", comesWithMirador: true };
  writeFileSync(catalogFile(), JSON.stringify({ plugins: [counter, tally, checklist] }));
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  publishCatalog();
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const pluginRows = (page: Page) => page.getByRole("list", { name: "Plugins", exact: true }).getByRole("listitem");
const moreOfficialPlugins = (page: Page) => page.getByRole("list", { name: "More official plugins" });

test("the agent recommends an official plugin, and Mirador installs it only once the user answers Install", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const ask = page.locator(".ask");

  await test.step("a plugin that isn't official, or comes with Mirador, is refused without asking", async () => {
    expect(await callCanvasTool(host, conversationId, "plugin_install", { name: "evil", reason: "r" })).toContain("evil is not an official plugin; they are counter, tally, checklist.");
    expect(await callCanvasTool(host, conversationId, "plugin_install", { name: "checklist", reason: "r" })).toContain("Checklist comes with Mirador.");
    await expect(ask).toHaveCount(0);
  });

  await test.step("Not now installs nothing, and the agent hears so", async () => {
    expect(await callCanvasTool(host, conversationId, "plugin_install", { name: "counter", reason: "You keep counting by hand." })).toContain("End your turn now.");
    await expect(ask).toContainText("Install the Counter plugin?");
    await ask.getByRole("radio", { name: /^Not now/ }).check();
    await ask.getByRole("button", { name: "Submit" }).click();
    await expect(page.locator(".message.user:visible").last()).toContainText("Nothing was installed.");
  });

  await test.step("Install clones the plugin into Mirador's plugins folder, and the agent hears to have the user restart", async () => {
    await callCanvasTool(host, conversationId, "plugin_install", { name: "counter", reason: "You keep counting by hand." });
    await expect(ask.frameLocator("iframe").first().getByText("You keep counting by hand.")).toBeVisible();
    await ask.getByRole("radio", { name: /^Install/ }).check();
    await ask.getByRole("button", { name: "Submit" }).click();
    await expect(page.locator(".message.user:visible").last()).toContainText("Mirador installed the Counter plugin and uses it from its next restart.", { timeout: 30_000 });
  });

  await test.step("Settings lists each plugin once: an official one in the plugins list with its tag and description, and those to install apart", async () => {
    await openSettings(page, "Plugins");
    await expect(pluginRows(page).filter({ hasText: "Checklist" })).toContainText(`checklistOfficialSteps, ticked.Comes with Mirador ${MIRADOR_VERSION}`);
    await expect(pluginRows(page).filter({ hasText: "Counter" }).locator(".plugin-official")).toHaveText("Official");
    await expect(pluginRows(page).filter({ hasText: "Counter" }).locator(".plugin-description")).toHaveText("Counts by one.");
    await expect(pluginRows(page).filter({ hasText: "Code review" })).not.toContainText("Official");
    await expect(moreOfficialPlugins(page).getByRole("listitem")).toHaveText(["TallytallyKeeps a tally.Install"]);
    await expect(page.locator(".restart-needed")).toBeVisible();
  });

  await test.step("Install in Settings clones the plugin too, which then leaves the plugins to install", async () => {
    await moreOfficialPlugins(page).getByRole("button", { name: "Install" }).click();
    await expect(pluginRows(page).filter({ hasText: "Tally" }).locator(".plugin-description")).toHaveText("Keeps a tally.", { timeout: 30_000 });
    await expect(pluginRows(page).filter({ hasText: "Tally" }).locator(".plugin-official")).toHaveText("Official");
    await expect(moreOfficialPlugins(page)).toHaveCount(0);
  });
});
