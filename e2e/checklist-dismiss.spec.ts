import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, createProfile, sendMessage, signIn } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";

const host = new TestHost({ fakePrograms: true });
const promptsFile = join(host.root, "prompts");
const profileName = "dismissable";

/** An opencode stand-in that is an agent of its own, taking prompts and ending its turns at once. */
function fakeOpencode() {
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: promptsFile });
}

test.beforeAll(async () => {
  fakeOpencode();
  writeFileSync(promptsFile, "");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const toggle = (page: Page) => page.locator(".checklist-toggle:visible");
const canvasTitle = (page: Page) => page.locator(".canvas-header:visible .canvas-title");
const checkbox = (page: Page, text: string) => page.locator(".checklist:visible .checklist-item", { hasText: text }).getByRole("checkbox");

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

const release = {
  title: "Release 0.4.2",
  sections: [{ items: [{ id: "tests", text: "Run the tests" }, { id: "build", text: "Build the app" }, { id: "publish", text: "Publish the release" }, { id: "announce", text: "Post the announcement" }] }],
};

test("a finished checklist is dismissed from the canvas and stays gone, while a new publishing brings one back", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  const conversationId = await startConversationWithoutModel(page);
  await sendAndWait(page, "Start");

  await test.step("publishing and ticking every item leaves the checklist the newest canvas thing, opening again when the conversation is revisited", async () => {
    await callCanvasTool(host, conversationId, "checklist", release);
    await expect(toggle(page)).toHaveText("Checklist 0/4");
    for (const text of ["Run the tests", "Build the app", "Publish the release", "Post the announcement"]) await checkbox(page, text).click();
    await expect(toggle(page)).toHaveText("Checklist 4/4");
    await page.reload();
    await expect(toggle(page)).toHaveText("Checklist 4/4");
    await expect(canvasTitle(page)).toHaveText("Release 0.4.2");
  });

  await test.step("dismissing takes the checklist off the canvas: the pane closes and the button goes with it", async () => {
    await page.getByRole("button", { name: "Dismiss the checklist" }).click();
    await expect(page.locator(".checklist:visible")).toHaveCount(0);
    await expect(toggle(page)).toHaveCount(0);
    await expect(canvasTitle(page)).toHaveText("Canvas");
  });

  await test.step("coming back to the conversation later, or loading it again, does not reopen it", async () => {
    await startConversationWithoutModel(page);
    await page.locator(`[data-reorder-id="${conversationId}"]`).click();
    await expect(page.locator(".checklist:visible")).toHaveCount(0);
    await expect(toggle(page)).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".checklist:visible")).toHaveCount(0);
    await expect(toggle(page)).toHaveCount(0);
    await expect(canvasTitle(page)).toHaveText("Canvas");
  });

  await test.step("the dismissed checklist is no longer the conversation's one; publishing afresh brings a checklist back", async () => {
    const update = await callCanvasTool(host, conversationId, "update_checklist", { items: [{ id: "tests", done: true }] });
    expect(update).toContain("This conversation has no checklist");
    const published = await callCanvasTool(host, conversationId, "checklist", release);
    expect(published).toContain("4 items, 0 of 4 done");
    expect(published).not.toContain("Done as on the checklist it replaces");
    await expect(toggle(page)).toHaveText("Checklist 0/4");
    await expect(canvasTitle(page)).toHaveText("Release 0.4.2");
  });
});
