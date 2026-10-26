import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, createProfile, openSettings, sendMessage, signIn } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";
import { MIRADOR_VERSION } from "../shared/version.ts";

const host = new TestHost({ copiesSource: true, fakePrograms: true });
const profileName = "shipped-plugins";
const fixtures = join(import.meta.dirname, "..", "tests", "fixtures");

/** Tally stands in for a plugin Mirador comes with: it is in the plugins/ folder of this host's own copy of Mirador. */
function shipTally() {
  host.copySource();
  cpSync(join(fixtures, "shipped-plugins", "tally"), join(host.sourceDir, "plugins", "tally"), { recursive: true });
}

/** The counter app installed in Mirador's data folder under the name of the plugin Mirador comes with. */
function installNamesake() {
  const folder = join(host.dataDir, "plugins", "my-tally");
  cpSync(join(fixtures, "apps", "counter"), folder, { recursive: true });
  const manifest = join(folder, "plugin.json");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace('"name": "counter"', '"name": "tally"'));
}

/** An opencode stand-in that is an agent of its own, taking prompts and ending its turns at once. */
function fakeOpencode() {
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: join(host.root, "prompts") });
  writeFileSync(join(host.root, "prompts"), "");
}

test.beforeAll(async () => {
  shipTally();
  installNamesake();
  fakeOpencode();
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const appToggle = (page: Page) => page.locator(".canvas-header:visible .app-toggle");
const view = (page: Page) => page.frameLocator(".canvas-panel:visible .canvas-frame.app iframe");

/** The stub agent offers no model to pick, so this is `startConversation` without that wait. */
async function startConversationWithoutModel(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

test("Settings lists the plugins Mirador comes with first, without update or remove, and keeps their names", async ({ page }) => {
  await signIn(page, host);
  const settings = await openSettings(page, "Plugins");
  const plugins = settings.getByRole("list", { name: "Plugins" }).getByRole("listitem");
  await expect(plugins).toHaveCount(4);
  await expect(plugins.nth(0)).toHaveText(`ChecklistchecklistComes with Mirador ${MIRADOR_VERSION}`);
  await expect(plugins.nth(1)).toHaveText(`Code reviewreviewComes with Mirador ${MIRADOR_VERSION}Open reviewsFull screen, over the chatIn the canvas pane, beside the chat`);
  await expect(plugins.nth(2)).toHaveText(`TallytallyComes with Mirador ${MIRADOR_VERSION}`);
  await expect(plugins.nth(2).getByRole("button")).toHaveCount(0);
  await expect(plugins.nth(3)).toHaveText("Countertally1.0.0A folder put there by handDidn't load: Mirador comes with a plugin named tallyRemove");
});

test("where this browser opened reviews before plugins had settings moves to the code review plugin's setting, once", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("moved")) localStorage.setItem("mirador-review-placement", "beside");
    sessionStorage.setItem("moved", "yes");
  });
  await signIn(page, host);
  const settings = await openSettings(page, "Plugins");
  const codeReview = settings.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ hasText: "Code review" });
  await expect(codeReview.getByLabel("Open reviews")).toHaveValue("beside");
  expect(await page.evaluate(() => localStorage.getItem("mirador-review-placement"))).toBeNull();
  await codeReview.getByLabel("Open reviews").selectOption("fullscreen");
  await page.reload();
  const again = await openSettings(page, "Plugins");
  await expect(again.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ hasText: "Code review" }).getByLabel("Open reviews")).toHaveValue("fullscreen");
});

test("the agent opens a plugin Mirador comes with, whose view Mirador bundled", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  const conversation = await startConversationWithoutModel(page);
  await sendMessage(page, "Start");
  await expect(page.locator(".chat-header:visible .badge")).toHaveText("idle", { timeout: 60_000 });

  expect(await callCanvasTool(host, conversation, "app_open", { app: "tally", file: "tally.json" })).toContain("Tally is open on tally.json");
  await expect(appToggle(page)).toHaveText("Tally");
  await expect(view(page).locator("#tally")).toHaveText("Tally: 0");
  await view(page).getByRole("button", { name: "Add one" }).click();
  await expect(view(page).locator("#tally")).toHaveText("Tally: 1");
  expect(JSON.parse(readFileSync(join(host.projectDir, "tally.json"), "utf8"))).toEqual({ count: 1 });
});
