import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, openSettings, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

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

const officialPlugins = async (page: Page) => (await openSettings(page, "Plugins")).getByRole("list", { name: "Official plugins" }).getByRole("listitem");

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

  await test.step("Settings lists the official plugins: the installed one as such, one to install, and the one that comes with Mirador", async () => {
    const official = await officialPlugins(page);
    await expect(official).toHaveText(["CountercounterCounts by one.Installed", "TallytallyKeeps a tally.Install", "ChecklistchecklistSteps, ticked.Comes with Mirador"]);
    await expect(page.locator(".restart-needed")).toBeVisible();
  });

  await test.step("Install in Settings clones the plugin too", async () => {
    const official = page.getByRole("list", { name: "Official plugins" }).getByRole("listitem");
    await official.filter({ hasText: "Tally" }).getByRole("button", { name: "Install" }).click();
    await expect(official.filter({ hasText: "Tally" })).toHaveText("TallytallyKeeps a tally.Installed", { timeout: 30_000 });
    await expect(page.getByRole("list", { name: "Plugins", exact: true }).getByRole("listitem").filter({ hasText: "Tally" })).toBeVisible();
  });
});
