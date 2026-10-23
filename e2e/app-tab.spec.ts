import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, createProfile, sendMessage, signIn } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";

const host = new TestHost({ fakePrograms: true });
const profileName = "app-tab";

/** An opencode stand-in that is an agent of its own, taking prompts and ending its turns at once. */
function fakeOpencode() {
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: join(host.root, "prompts") });
}

/** The counter app the unit tests use, installed the way an owner installs a plugin: a folder in Mirador's data folder. */
function installCounterApp() {
  cpSync(join(import.meta.dirname, "..", "tests", "fixtures", "apps", "counter"), join(host.dataDir, "plugins", "counter"), { recursive: true });
}

test.beforeAll(async () => {
  fakeOpencode();
  installCounterApp();
  writeFileSync(join(host.root, "prompts"), "");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const appToggle = (page: Page) => page.locator(".canvas-header:visible .app-toggle");
const canvasTitle = (page: Page) => page.locator(".canvas-header:visible .canvas-title");
const view = (page: Page) => page.frameLocator(".canvas-panel:visible .canvas-frame.app iframe");
const counterFile = () => join(host.projectDir, "counter.json");

/** The stub agent offers no model to pick, so this is `startConversation` without that wait. */
async function startConversationWithoutModel(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

async function sendAndWait(page: Page, text: string) {
  await sendMessage(page, text);
  await expect(page.locator(".chat-header:visible .badge")).toHaveText("idle", { timeout: 60_000 });
}

test("the agent opens an app that its changes, your clicks and outside edits all reach live, in every conversation of the workspace", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  const first = await startConversationWithoutModel(page);
  await sendAndWait(page, "Start");
  let pageLoad = "";

  await test.step("app_open starts the file and shows the app in its tab", async () => {
    const opened = await callCanvasTool(host, first, "app_open", { app: "counter", file: "counter.json" });
    expect(opened).toContain("Counter is open on counter.json; the user sees it in the canvas.");
    expect(opened).toContain("The count is 0.");
    await expect(appToggle(page)).toHaveText("Counter");
    await expect(appToggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(canvasTitle(page)).toHaveText("Counter");
    await expect(view(page).locator("#count")).toHaveText("0");
    expect(JSON.parse(readFileSync(counterFile(), "utf8"))).toEqual({ count: 0 });
    pageLoad = (await view(page).locator("#page-load").textContent())!;
  });

  await test.step("the agent's operation reaches the view without reloading it", async () => {
    expect(await callCanvasTool(host, first, "apply", { op: { op: "add", by: 2 } })).toBe("Added 2; the count is 2.");
    await expect(view(page).locator("#count")).toHaveText("2");
    await expect(view(page).locator("#last-change")).toHaveText("agent: Added 2; the count is 2.");
    await expect(view(page).locator("#page-load")).toHaveText(pageLoad);
  });

  await test.step("an operation the app refuses changes nothing, and the agent hears why", async () => {
    expect(await callCanvasTool(host, first, "apply", { op: { op: "multiply" } })).toContain('Unknown operation; use { op: "add", by: <number> }.');
    await expect(view(page).locator("#count")).toHaveText("2");
  });

  await test.step("a click in the view is your operation, and the file holds it", async () => {
    await view(page).getByRole("button", { name: "Add one" }).click();
    await expect(view(page).locator("#count")).toHaveText("3");
    await expect(view(page).locator("#last-change")).toHaveText("you: Added 1; the count is 3.");
    expect(JSON.parse(readFileSync(counterFile(), "utf8"))).toEqual({ count: 3 });
  });

  await test.step("an edit of the file outside Mirador shows in the view", async () => {
    writeFileSync(counterFile(), '{ "count": 40 }\n');
    await expect(view(page).locator("#count")).toHaveText("40");
    await expect(view(page).locator("#last-change")).toHaveText("outside: Edited outside Mirador");
    await expect(view(page).locator("#page-load")).toHaveText(pageLoad);
  });

  await test.step("words the view sends go to this conversation's agent, naming the app and its file", async () => {
    await view(page).getByRole("button", { name: "Ask about the count" }).click();
    await expect(page.locator(".canvas-panel:visible .app-sent")).toHaveText("Sent to the agent. The answer comes in the chat.");
    await expect(page.locator(".chat-header:visible .badge")).toHaveText("idle", { timeout: 60_000 });
    await expect.poll(() => readFileSync(join(host.root, "prompts"), "utf8")).toContain("About counter.json, open in Counter (app_state reads it, apply changes it):\n\nIs 40 a good count?\n");
    await expect(page.locator(".timeline:visible .message.user").last()).toContainText("Is 40 a good count?");
  });

  await test.step("another conversation of the workspace has the same app, and its agent reads every change", async () => {
    const second = await startConversationWithoutModel(page);
    await sendAndWait(page, "Start");
    await expect(appToggle(page)).toHaveText("Counter");
    await appToggle(page).click();
    await expect(view(page).locator("#count")).toHaveText("40");
    const state = await callCanvasTool(host, second, "app_state", {});
    expect(state).toContain("The count is 40.");
    expect(state).toContain("1. agent: Added 2; the count is 2.\n2. user: Added 1; the count is 3.\n3. edited outside Mirador: Edited outside Mirador");
  });
});
