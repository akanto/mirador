import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, createProfile, openProfiles, sendMessage, signIn } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5270, { fakePrograms: true });
const promptsFile = join(host.root, "prompts");
const profileName = "wedged";

/** An opencode that is an agent of its own, taking prompts and never finishing them. */
function fakeOpencode() {
  mkdirSync(host.fakeProgramsDir, { recursive: true });
  writeFileSync(
    join(host.fakeProgramsDir, "opencode"),
    `#!/bin/sh\nFAKE_ACP_PROMPTS='${promptsFile}' exec bun '${join(import.meta.dirname, "fake-acp-agent.ts")}' "$@"\n`,
  );
  chmodSync(join(host.fakeProgramsDir, "opencode"), 0o755);
}

/** The prompts the agent was given, in the order they arrived. */
const prompts = () =>
  readFileSync(promptsFile, "utf8")
    .split("\n")
    .filter((text) => text !== "");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fakeOpencode();
  writeFileSync(promptsFile, "");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const status = (page: Page) => page.locator(".chat-header:visible .badge");
const selectInSidebar = (page: Page, conversationId: string) => page.locator(`[data-reorder-id="${conversationId}"]`).click();

/** The stub agent offers no model to pick, so this is `startConversation` without that wait. */
async function startConversationWithoutModel(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

async function wedgedConversation(page: Page, text: string) {
  const conversationId = await startConversationWithoutModel(page);
  await sendMessage(page, text);
  await expect(status(page)).toHaveText("running", { timeout: 30_000 });
  return conversationId;
}

test("Stop offers to kill the agent process, and killing it leaves the other conversations on that profile running", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });

  const stopped = await wedgedConversation(page, "WEDGE one");
  const sibling = await wedgedConversation(page, "WEDGE two");

  await selectInSidebar(page, stopped);
  const stop = page.locator(".composer:visible .stop");
  await stop.click();
  await expect(stop).toHaveText("Stopping…");

  await test.step("Esc again asks only once more, rather than killing the agent", async () => {
    await page.locator(".composer:visible textarea").focus();
    await page.keyboard.press("Escape");
    await expect(status(page)).toHaveText("running");
    expect(prompts()).toHaveLength(2);
  });

  await expect(stop).toHaveText("Force stop", { timeout: 10_000 });
  await expect(status(page)).toHaveText("running");

  await stop.click();
  await expect(status(page)).toHaveText("idle", { timeout: 30_000 });
  await expect(page.locator(".timeline:visible")).toContainText("Turn ended: cancelled");
  await expect(page.locator(".timeline:visible .message.user")).toHaveCount(1);

  await expect.poll(() => prompts().filter((text) => text === "WEDGE two").length, { timeout: 30_000 }).toBe(2);
  await selectInSidebar(page, sibling);
  await expect(status(page)).toHaveText("running", { timeout: 30_000 });
});

const profilePicker = (page: Page) => page.getByLabel("Profile", { exact: true }).filter({ visible: true });
const timeline = (page: Page) => page.locator(".timeline:visible");
const sentTimes = (text: string) => prompts().filter((prompt) => prompt === text).length;

async function signInToWorkspace(page: Page) {
  await signIn(page, host);
  await page.locator(".workspace li").first().click();
}

test("A profile switch that the agent ignores the cancel of kills the agent after a while and continues the turn on the new profile", async ({ page }) => {
  await signInToWorkspace(page);
  const profiles = await createProfile(page, "spare", "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await wedgedConversation(page, "WEDGE before the switch");

  await profilePicker(page).selectOption({ label: "spare" });
  await expect(timeline(page)).toContainText("Turn ended: cancelled", { timeout: 30_000 });
  await expect(timeline(page)).toContainText("Now using the profile “spare”");
  await expect.poll(() => sentTimes("WEDGE before the switch"), { timeout: 30_000 }).toBe(2);
  await expect(status(page)).toHaveText("running");
  await expect(timeline(page).locator(".error-line")).toHaveCount(0);
});

test("An agent process that dies in the middle of a turn ends it with one error that says so", async ({ page }) => {
  await signInToWorkspace(page);
  await startConversationWithoutModel(page);
  await sendMessage(page, "CRASH now");

  await expect(timeline(page).locator(".error-line")).toHaveText(/agent process exited with 1/, { timeout: 30_000 });
  await expect(status(page)).toHaveText("idle");
  await expect(timeline(page).locator(".error-line")).toHaveCount(1);
});

test("Saving a changed profile stops the turns its agent runs, as Stop does, and continues them on the restarted agent", async ({ page }) => {
  await signInToWorkspace(page);
  await wedgedConversation(page, "WEDGE before the edit");

  const dialog = await openProfiles(page);
  await dialog.locator(".profile-list li", { hasText: profileName }).click();
  await dialog.getByRole("button", { name: "Edit environment" }).click();
  await dialog.getByLabel("Environment", { exact: true }).fill("EDITED=1");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Saved")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  await expect(timeline(page)).toContainText("Turn ended: cancelled", { timeout: 30_000 });
  await expect.poll(() => sentTimes("WEDGE before the edit"), { timeout: 30_000 }).toBe(2);
  await expect(status(page)).toHaveText("running");
  await expect(timeline(page).locator(".error-line")).toHaveCount(0);
});
