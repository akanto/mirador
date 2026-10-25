import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, createProfile, openSettings, sendMessage, signIn } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";

const host = new TestHost({ fakePrograms: true });
const profileName = "plugin-install";
const repo = () => join(host.root, "counter-repo");

const git = (folder: string, ...args: string[]) =>
  execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" }).trim();

/** The counter app the unit tests use, in a repo of its own whose view only exists once its build ran, as with a bundled view. */
function counterRepo() {
  const counter = join(import.meta.dirname, "..", "tests", "fixtures", "apps", "counter");
  cpSync(counter, repo(), { recursive: true });
  mkdirSync(join(repo(), "src"));
  cpSync(join(counter, "view.js"), join(repo(), "src", "view.js"));
  rmSync(join(repo(), "view.js"));
  writeFileSync(join(repo(), ".gitignore"), "/view.js\n");
  writeFileSync(join(repo(), "build.ts"), 'await Bun.write("view.js", Bun.file("src/view.js"));\n');
  writeFileSync(join(repo(), "plugin.json"), JSON.stringify({ name: "counter", title: "Counter", api: 1, app: { host: "host.ts", view: "view.js" }, build: "bun build.ts" }));
  git(repo(), "init", "--quiet", "-b", "main");
  git(repo(), "add", ".");
  git(repo(), "commit", "--quiet", "-m", "Count by one");
}

test.beforeAll(async () => {
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: join(host.root, "prompts") });
  counterRepo();
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const pluginRows = (settings: ReturnType<Page["getByRole"]>) => settings.getByRole("list", { name: "Plugins" }).getByRole("listitem");
const counterRow = (settings: ReturnType<Page["getByRole"]>) => pluginRows(settings).filter({ hasText: "Counter" });
const view = (page: Page) => page.frameLocator(".canvas-panel:visible .canvas-frame.app iframe");
const appToggle = (page: Page) => page.locator(".canvas-header:visible .app-toggle");

async function restartFromSettings(page: Page) {
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Restart host" }).click();
  await expect(settings, "the page reloads once the restarted host answers").toBeHidden({ timeout: 30_000 });
}

/** The canvas tools the conversation's agent is offered; the app tools only while an app is installed. */
async function canvasToolNames(conversationId: string): Promise<string[]> {
  const response = await fetch(`${host.origin}/mcp/${conversationId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${host.mcpToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await response.text();
  const message = JSON.parse(body.split("\n").find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? body);
  return message.result.tools.map(({ name }: { name: string }) => name);
}

/** The stub agent offers no model to pick, so this is `startConversation` without that wait. */
async function startConversationWithoutModel(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

test("a plugin added from a git repo is built, works after a restart, updates to new commits, and goes when removed", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  const conversation = await startConversationWithoutModel(page);
  await sendMessage(page, "Start");
  await expect(page.locator(".chat-header:visible .badge")).toHaveText("idle", { timeout: 60_000 });

  await test.step("a repo git can't clone is refused with git's own words", async () => {
    const settings = await openSettings(page, "Plugins");
    await settings.getByLabel("Git URL or path").fill(join(host.root, "no-such-repo"));
    await settings.getByRole("button", { name: "Add" }).click();
    await expect(settings.getByRole("form", { name: "Add a plugin" }).locator(".plugin-output")).toContainText("git clone failed:");
    await expect(pluginRows(settings)).toHaveText(["ChecklistchecklistComes with Mirador"]);
  });

  await test.step("adding clones and builds the repo, and the app works from the next start", async () => {
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByLabel("Git URL or path").fill(repo());
    await settings.getByLabel("Branch").fill("main");
    await settings.getByRole("button", { name: "Add" }).click();
    await expect(counterRow(settings)).toContainText(`Countercounterused from the next start${repo()} · main · ${git(repo(), "rev-parse", "--short", "HEAD")} Count by one`);
    await expect(settings.getByText("Mirador uses the changed plugins from its next start.")).toBeVisible();
    await expect(settings.getByLabel("Git URL or path")).toHaveValue("");
    await restartFromSettings(page);

    expect(await callCanvasTool(host, conversation, "app_open", { app: "counter", file: "counter.json" })).toContain("Counter is open on counter.json");
    await expect(view(page).getByRole("button", { name: "Add one" })).toBeVisible();
  });

  await test.step("an update lists the commits the plugin doesn't have, then installs them for the next start", async () => {
    const settings = await openSettings(page, "Plugins");
    await settings.getByRole("button", { name: "Check for updates" }).click();
    await expect(settings.getByText("Up to date.")).toBeVisible();

    writeFileSync(join(repo(), "src", "view.js"), "document.body.innerHTML = '<p id=\"count\">Counting by two</p>';\n");
    git(repo(), "commit", "--quiet", "-am", "Count by two");
    await settings.getByRole("button", { name: "Check again" }).click();
    await expect(settings.getByRole("list", { name: "New commits of Counter" })).toHaveText(`${git(repo(), "rev-parse", "--short", "HEAD")} Count by two`);
    await settings.getByRole("button", { name: "Update" }).click();
    await expect(counterRow(settings)).toContainText("used from the next start");
    await expect(counterRow(settings)).toContainText("Count by two");
    await restartFromSettings(page);
    await appToggle(page).click();
    await expect(view(page).locator("#count")).toHaveText("Counting by two");
  });

  await test.step("removing the plugin with its app open: after the restart the app is gone and the host is fine", async () => {
    const settings = await openSettings(page, "Plugins");
    await settings.getByRole("button", { name: "Remove Counter" }).click();
    await settings.getByRole("button", { name: "Confirm: Remove Counter" }).click();
    await expect(pluginRows(settings)).toHaveText(["ChecklistchecklistComes with Mirador"]);
    await restartFromSettings(page);
    await expect(appToggle(page)).toHaveCount(0);
    expect(await canvasToolNames(conversation)).not.toContain("app_open");
  });
});
