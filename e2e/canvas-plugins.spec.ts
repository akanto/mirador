import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, chooseInSettings, createProfile, sendMessage, signIn } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";

const host = new TestHost({ fakePrograms: true });
const promptsFile = join(host.root, "prompts");
const profileName = "board";
const boardFolder = join(host.dataDir, "plugins", "board");
const agentSaw = () => readFileSync(promptsFile, "utf8");

/** An opencode stand-in that is an agent of its own, taking prompts and ending its turns at once. */
function fakeOpencode() {
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: promptsFile });
}

test.beforeAll(async () => {
  cpSync(join(import.meta.dirname, "..", "tests", "fixtures", "canvas-plugins", "board"), boardFolder, { recursive: true });
  fakeOpencode();
  writeFileSync(promptsFile, "");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const canvasTitle = (page: Page) => page.locator(".canvas-header:visible .canvas-title");
const canvasKind = (page: Page) => page.locator(".canvas-header:visible .canvas-kind");
const toggle = (page: Page) => page.locator(".checklist-toggle:visible");
const pageView = (page: Page) => page.frameLocator(".canvas-panel:visible .canvas-body > .canvas-frame.plugin iframe");
const tabView = (page: Page) => page.frameLocator(".checklist:visible .canvas-frame.plugin iframe");

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

test("a plugin's tools show its items on the canvas and in the tab, its view takes the user's actions, and the agent hears of them", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  const conversationId = await startConversationWithoutModel(page);
  await sendAndWait(page, "Start");

  await test.step("the plugin's tool shows a card among the canvas's pages, drawn by the plugin's view", async () => {
    expect(await callCanvasTool(host, conversationId, "show_card", { title: "Hello", text: "First" })).toMatch(/^Shown as [0-9a-f-]+\.$/);
    await expect(canvasTitle(page)).toHaveText("Hello");
    await expect(canvasKind(page)).toHaveText("▤");
    await expect(pageView(page).locator("#title")).toHaveText("Hello");
    await expect(pageView(page).locator("#text")).toHaveText("First (pressed 0 times)");
  });

  await test.step("another tool changes the card in place", async () => {
    expect(await callCanvasTool(host, conversationId, "change_card", { text: "Second" })).toBe("Changed.");
    await expect(pageView(page).locator("#text")).toHaveText("Second (pressed 0 times)");
    await expect(page.getByRole("button", { name: "History (1)" })).toBeVisible();
  });

  await test.step("the user's action in the view reaches the plugin, and its reply or refusal comes back", async () => {
    await pageView(page).getByRole("button", { name: "Press" }).click();
    await expect(pageView(page).locator("#reply")).toHaveText("Pressed 1 times");
    await expect(pageView(page).locator("#text")).toHaveText("Second (pressed 1 times)");
    await pageView(page).getByRole("button", { name: "Do what cards don't" }).click();
    await expect(pageView(page).locator("#reply")).toHaveText("A card can only be pressed.");
  });

  await test.step("the view looks like Mirador: its colours and font scale reach it, and follow a change", async () => {
    const themed = pageView(page).locator("#theme");
    const panelText = await page.locator(".canvas-panel:visible").evaluate((panel) => getComputedStyle(panel).color);
    await expect(themed).toHaveCSS("color", panelText);
    await expect(themed).toHaveCSS("font-size", "10px");
    await chooseInSettings(page, "Text size", "140%");
    await expect(themed).toHaveCSS("font-size", "14px");
    await chooseInSettings(page, "Text size", "100%");
  });

  await test.step("a hint in the view shows as Mirador's own, and a link in it opens in a new tab", async () => {
    await pageView(page).locator("#hinted").hover();
    await expect(page.getByRole("tooltip")).toHaveText("What the board says about itself.");
    const viewBox = (await page.locator(".canvas-panel:visible .canvas-body > .canvas-frame.plugin").boundingBox())!;
    const hintBox = (await page.getByRole("tooltip").boundingBox())!;
    expect(hintBox.y).toBeGreaterThan(viewBox.y);
    await page.context().route("https://example.invalid/board", (route) => route.fulfill({ body: "The board's site" }));
    const opened = page.context().waitForEvent("page");
    await pageView(page).getByRole("link", { name: "The board's site" }).click();
    expect((await opened).url()).toBe("https://example.invalid/board");
  });

  await test.step("the agent hears of the presses with the next message, once", async () => {
    await sendAndWait(page, "Carry on");
    expect(agentSaw()).toContain('The user pressed the card "Hello" 1 times.\n\nCarry on\n');
    await sendAndWait(page, "And again");
    expect(agentSaw().endsWith("Carry on\nAnd again\n")).toBe(true);
  });

  await test.step("an item for the tab opens there, with its count on the toggle and its icon and title in the header", async () => {
    await callCanvasTool(host, conversationId, "track_steps", { title: "Release", steps: ["Build", "Ship"] });
    await expect(toggle(page)).toHaveText("Checklist 0/2");
    await expect(canvasTitle(page)).toHaveText("Release");
    await expect(canvasKind(page)).toHaveText("◔");
    await expect(tabView(page).locator("#text")).toHaveText("0 of 2 steps done");
    await callCanvasTool(host, conversationId, "finish_step", {});
    await expect(toggle(page)).toHaveText("Checklist 1/2");
    await expect(tabView(page).locator("#text")).toHaveText("1 of 2 steps done");
    await expect(page.getByRole("button", { name: "History (1)" })).toBeVisible();
  });

  await test.step("the view knows which of the agent's changes the user hasn't seen yet", async () => {
    await expect(tabView(page).locator("#unseen")).toHaveText("Changed since you looked");
    await page.getByRole("button", { name: "Close the checklist" }).click();
    await toggle(page).click();
    await expect(tabView(page).locator("#unseen")).toHaveText("Nothing new");
    await page.getByRole("button", { name: "Close the checklist" }).click();
    await callCanvasTool(host, conversationId, "finish_step", {});
    await expect(toggle(page)).toHaveText("Checklist 2/2");
    await toggle(page).click();
    await expect(tabView(page).locator("#unseen")).toHaveText("Changed since you looked");
  });

  await test.step("dismissing takes the item out of the tab, and the plugin knows", async () => {
    await page.getByRole("button", { name: "Dismiss the checklist" }).click();
    await expect(toggle(page)).toHaveCount(0);
    await expect(canvasTitle(page)).toHaveText("Hello");
    await page.reload();
    await expect(toggle(page)).toHaveCount(0);
    expect(await callCanvasTool(host, conversationId, "finish_step", {})).toBe("There are no steps to tick off.");
    await expect(canvasKind(page)).toHaveText("▤");
  });

  await test.step("with the plugin gone, its card shows what it published instead of a blank page", async () => {
    rmSync(boardFolder, { recursive: true });
    await host.restart();
    await page.reload();
    await expect(canvasTitle(page)).toHaveText("Hello");
    await expect(page.locator(".canvas-panel:visible .plugin-item-missing")).toContainText("The board plugin isn't installed, so this is what it published, as it is.");
    await expect(page.locator(".canvas-panel:visible .plugin-item-missing pre")).toContainText('"text": "Second"');
  });
});
