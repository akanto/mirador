import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, createProfile, sendMessage, signIn } from "./helpers.ts";
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
