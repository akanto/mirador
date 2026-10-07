import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { addWorkspace, addWorkspaceFromSidebar, callCanvasTool, dragOnto, signIn, workspaceCard } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5315);
const alphaDir = join(host.root, "alpha");
const betaDir = join(host.root, "beta");
const gammaDir = join(host.root, "gamma");

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  [alphaDir, betaDir, gammaDir].forEach((directory) => mkdirSync(directory, { recursive: true }));
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const group = (page: Page, name: string) => page.locator(".workspace-group", { has: page.locator(".group-name", { hasText: new RegExp(`^${name}$`) }) });
const heading = (page: Page, name: string) => group(page, name).locator(":scope > header");
const workspaceHeader = (page: Page, directory: string) => workspaceCard(page, directory).locator(":scope > header");
const names = (cards: Locator) => cards.locator(".workspace-name").allTextContents();
const ungroupedNames = (page: Page) => names(page.locator(".sidebar > section.workspace"));
const namesIn = (page: Page, groupName: string) => names(group(page, groupName).locator("section.workspace"));
const groupNames = (page: Page) => page.locator(".workspace-group .group-name").allTextContents();

async function newGroup(page: Page, name: string) {
  await page.getByRole("button", { name: "New group" }).click();
  const field = page.getByLabel("New group name");
  await field.fill(name);
  await field.press("Enter");
  await expect(group(page, name)).toBeVisible();
}

async function drop(page: Page, item: Locator, target: Locator, edge: "top" | "bottom") {
  await dragOnto(page, item, target, edge);
  await page.mouse.up();
}

async function startConversationIn(page: Page, directory: string) {
  const previousUrl = page.url();
  await workspaceCard(page, directory).getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

async function runFromPalette(page: Page, label: string) {
  await page.locator(".sidebar").getByRole("button", { name: /^Palette/ }).click();
  await page.getByPlaceholder(/Go to a conversation/).fill(label);
  await page.keyboard.press("Enter");
}

test("workspaces gather in groups that fold, take a new name and order, and leave their workspaces on top when deleted", async ({ page, browser }) => {
  await signIn(page, host);
  await addWorkspace(page, alphaDir);
  await addWorkspaceFromSidebar(page, betaDir);
  await addWorkspaceFromSidebar(page, gammaDir);

  await test.step("a new group is named in place and shows below the workspaces in none", async () => {
    await newGroup(page, "Clients");
    await newGroup(page, "Own");
    expect(await groupNames(page)).toEqual(["Clients", "Own"]);
    await expect(heading(page, "Clients").locator(".group-name")).toHaveCSS("text-transform", "uppercase");
    await expect(heading(page, "Clients").locator(".group-count")).toHaveText("0");
    await expect(group(page, "Clients")).toContainText("Drag a workspace here by its heading");
  });

  await test.step("a workspace dragged by its heading onto a group's heading goes last in it, and onto a workspace's top edge, just before it", async () => {
    await drop(page, workspaceHeader(page, betaDir), heading(page, "Clients"), "top");
    await expect.poll(() => namesIn(page, "Clients")).toEqual(["beta"]);
    await dragOnto(page, workspaceHeader(page, alphaDir), workspaceCard(page, betaDir), "top");
    await expect(workspaceCard(page, betaDir)).toHaveClass(/drop-before/);
    await page.mouse.up();
    await expect.poll(() => namesIn(page, "Clients")).toEqual(["alpha", "beta"]);
    await drop(page, workspaceHeader(page, gammaDir), heading(page, "Own"), "top");
    await expect.poll(() => namesIn(page, "Own")).toEqual(["gamma"]);
    expect(await ungroupedNames(page)).toEqual([]);
    await expect(heading(page, "Clients").locator(".group-count")).toHaveText("2");
  });

  await test.step("with no workspace in none, a place to drop shows at the top while one is dragged, and takes it out of its group", async () => {
    await expect(page.locator(".ungrouped-drop")).toHaveCount(0);
    await dragOnto(page, workspaceHeader(page, gammaDir), page.locator(".sidebar > header"), "bottom");
    await expect(page.locator(".ungrouped-drop")).toBeVisible();
    await page.mouse.move(100, ((await page.locator(".ungrouped-drop").boundingBox())!.y + 10), { steps: 4 });
    await expect(page.locator(".ungrouped-drop")).toHaveClass(/drop-into/);
    await page.mouse.up();
    await expect.poll(() => ungroupedNames(page)).toEqual(["gamma"]);
    await expect(page.locator(".ungrouped-drop")).toHaveCount(0);
    await drop(page, workspaceHeader(page, gammaDir), heading(page, "Own"), "top");
    await expect.poll(() => namesIn(page, "Own")).toEqual(["gamma"]);
  });

  await test.step("a folded group hides its workspaces, counts them and what waits in them, and stays folded in this browser only", async () => {
    const waiting = await startConversationIn(page, alphaDir);
    await startConversationIn(page, gammaDir);
    await page.getByRole("button", { name: "Fold Clients" }).click();
    await expect(page.getByRole("button", { name: "Unfold Clients" })).toHaveAttribute("aria-expanded", "false");
    await expect(group(page, "Clients").locator("section.workspace")).toHaveCount(0);
    await expect(heading(page, "Clients").locator(".group-count")).toHaveText("2");
    void callCanvasTool(host, waiting, "ask", { question: "Which layout?", options: [{ label: "Yes" }, { label: "No" }] }).catch(() => {});
    await expect(heading(page, "Clients").locator(".waiting-count")).toHaveText("1");
    await expect(heading(page, "Own").locator(".waiting-count")).toHaveCount(0);

    await page.reload();
    await expect(group(page, "Clients").locator("section.workspace")).toHaveCount(0);
    const otherBrowser = await browser.newContext();
    const otherPage = await otherBrowser.newPage();
    await signIn(otherPage, host);
    expect(await groupNames(otherPage)).toEqual(["Clients", "Own"]);
    expect(await namesIn(otherPage, "Clients")).toEqual(["alpha", "beta"]);
    await otherBrowser.close();
  });

  await test.step("opening a conversation in a folded group unfolds it", async () => {
    await runFromPalette(page, "New conversation in alpha");
    await expect(page.getByRole("button", { name: "Fold Clients" })).toHaveAttribute("aria-expanded", "true");
    expect(await namesIn(page, "Clients")).toEqual(["alpha", "beta"]);
  });

  await test.step("a group is renamed in place, and dragged by its heading above another", async () => {
    await heading(page, "Clients").hover();
    await heading(page, "Clients").getByRole("button", { name: "Rename group" }).click();
    const field = page.getByLabel("Group name", { exact: true });
    await field.fill("Customers");
    await field.press("Enter");
    await expect(group(page, "Customers")).toBeVisible();
    await drop(page, heading(page, "Own"), heading(page, "Customers"), "top");
    await expect.poll(() => groupNames(page)).toEqual(["Own", "Customers"]);
    await page.reload();
    expect(await groupNames(page)).toEqual(["Own", "Customers"]);
  });

  await test.step("deleting a group keeps its workspaces, last among those in none", async () => {
    await drop(page, workspaceHeader(page, gammaDir), page.locator(".sidebar > header"), "bottom");
    await expect.poll(() => ungroupedNames(page)).toEqual(["gamma"]);
    await heading(page, "Customers").hover();
    const remove = heading(page, "Customers").getByRole("button", { name: "Delete group" });
    await remove.click();
    await remove.click();
    await expect(group(page, "Customers")).toHaveCount(0);
    await expect.poll(() => ungroupedNames(page)).toEqual(["gamma", "alpha", "beta"]);
    expect(await groupNames(page)).toEqual(["Own"]);
  });
});

test("the palette makes a group and moves a workspace into one or out of its own", async ({ page }) => {
  await signIn(page, host);
  await runFromPalette(page, "New group");
  await page.getByLabel("New group name").fill("Later");
  await page.getByLabel("New group name").press("Enter");
  await expect(group(page, "Later")).toBeVisible();

  await runFromPalette(page, "Move beta to group Later");
  await expect.poll(() => namesIn(page, "Later")).toEqual(["beta"]);
  await runFromPalette(page, "Move beta to group Own");
  await expect.poll(() => namesIn(page, "Own")).toEqual(["beta"]);
  await runFromPalette(page, "Take beta out of group Own");
  await expect.poll(() => ungroupedNames(page)).toEqual(["gamma", "alpha", "beta"]);
});
