import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, addWorkspaceFromSidebar, signIn, workspaceCard } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost();
const alphaDir = join(host.root, "alpha");
const betaDir = join(host.root, "beta");

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  [alphaDir, betaDir].forEach((directory) => mkdirSync(directory, { recursive: true }));
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const filterField = (page: Page) => page.getByLabel("Filter workspaces and conversations");
const shownWorkspaces = (page: Page) => page.locator(".sidebar .workspace-name");
const shownTitles = (page: Page) => page.locator(".sidebar .conversation-title");

async function startTitled(page: Page, directory: string, title: string) {
  const previousUrl = page.url();
  await workspaceCard(page, directory).getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  const row = workspaceCard(page, directory).locator("li.selected .conversation-title");
  await row.dblclick();
  const field = page.getByLabel("Conversation name");
  await field.fill(title);
  await field.press("Enter");
  await expect(row).toHaveText(title);
}

test("the sidebar filters to the workspaces and conversations whose names hold every word typed, and Esc brings everything back", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, alphaDir);
  await addWorkspaceFromSidebar(page, betaDir);
  await startTitled(page, alphaDir, "Queue steering");
  await startTitled(page, alphaDir, "Login bug");
  await startTitled(page, betaDir, "Queue of tickets");

  await test.step("a word in conversation titles keeps just those conversations, in their workspaces", async () => {
    await filterField(page).fill("queue");
    await expect(shownWorkspaces(page)).toHaveText(["beta", "alpha"]);
    await expect(shownTitles(page)).toHaveText(["Queue of tickets", "Queue steering"]);
  });

  await test.step("a workspace's name with a title word narrows to that one conversation", async () => {
    await filterField(page).fill("ALPHA queue");
    await expect(shownWorkspaces(page)).toHaveText(["alpha"]);
    await expect(shownTitles(page)).toHaveText(["Queue steering"]);
  });

  await test.step("a workspace's name alone keeps all its conversations", async () => {
    await filterField(page).fill("alph");
    await expect(shownTitles(page)).toHaveText(["Queue steering", "Login bug"]);
  });

  await test.step("nothing matching says so", async () => {
    await filterField(page).fill("nowhere");
    await expect(shownWorkspaces(page)).toHaveCount(0);
    await expect(page.locator(".sidebar")).toContainText("Nothing here matches “nowhere”");
  });

  await test.step("the shortcut goes to the filter from the message box, and the shortcuts list names it", async () => {
    await page.locator(".composer:visible textarea").click();
    await page.keyboard.press("ControlOrMeta+Shift+E");
    await expect(filterField(page)).toBeFocused();
    await expect(filterField(page)).toHaveValue("nowhere");
    await page.keyboard.type("queue");
    await expect(shownTitles(page)).toHaveText(["Queue of tickets", "Queue steering"]);
    await page.locator(".sidebar").getByRole("button", { name: /^Shortcuts/ }).click();
    await expect(page.locator(".shortcut-help")).toContainText("Filter the sidebar");
    await page.keyboard.press("Escape");
    await page.locator(".composer:visible textarea").click();
    await page.keyboard.press("ControlOrMeta+K");
    await page.getByPlaceholder(/Go to a conversation/).fill("filter the sidebar");
    await page.keyboard.press("Enter");
    await expect(filterField(page)).toBeFocused();
  });

  await test.step("Esc clears the filter", async () => {
    await filterField(page).press("Escape");
    await expect(filterField(page)).toHaveValue("");
    await filterField(page).fill("nowhere");
    await filterField(page).press("Escape");
    await expect(filterField(page)).toHaveValue("");
    await expect(shownWorkspaces(page)).toHaveText(["beta", "alpha"]);
    await expect(shownTitles(page)).toHaveCount(3);
  });
});
