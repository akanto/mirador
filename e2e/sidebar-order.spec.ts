import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { addWorkspace, signIn, startConversation, workspaceCard } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5110);
const secondDir = join(host.root, "second");

test.beforeAll(async () => {
  mkdirSync(host.projectDir, { recursive: true });
  mkdirSync(secondDir, { recursive: true });
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const idsOf = (items: Locator) => items.evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.reorderId));
const workspaceIds = (page: Page) => idsOf(page.locator(".sidebar > section.workspace"));
const conversationIds = (page: Page, directory: string) => idsOf(workspaceCard(page, directory).locator("li[data-reorder-id]"));

/** Presses on the item and moves to just inside the top or bottom edge of the target, leaving the button down. */
async function dragOnto(page: Page, item: Locator, target: Locator, edge: "top" | "bottom") {
  const from = (await item.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, edge === "top" ? to.y + 3 : to.y + to.height - 3, { steps: 10 });
}

test("workspaces, and conversations within theirs, are dragged into an order every window keeps", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const [first, second, third] = [await startConversation(page), await startConversation(page), await startConversation(page)];
  const row = (id: string) => page.locator(`li[data-reorder-id="${id}"]`);

  await test.step("a conversation dragged below another lands there, selecting no text on the way, and the drag opens nothing", async () => {
    expect(await conversationIds(page, host.projectDir)).toEqual([first, second, third]);
    await dragOnto(page, row(first), row(third), "bottom");
    await expect(row(third)).toHaveClass(/drop-after/);
    await expect(row(first)).toHaveClass(/dragged/);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
    await page.mouse.up();
    await expect.poll(() => conversationIds(page, host.projectDir)).toEqual([second, third, first]);
    await expect(row(third)).toHaveClass(/selected/);
  });

  await test.step("another window shows the same order, and so does a reload", async () => {
    const otherWindow = await page.context().newPage();
    await otherWindow.goto(page.url());
    await expect.poll(() => conversationIds(otherWindow, host.projectDir)).toEqual([second, third, first]);
    await otherWindow.close();
    await page.reload();
    await expect.poll(() => conversationIds(page, host.projectDir)).toEqual([second, third, first]);
  });

  await test.step("a short drag that ends on its own row neither moves nor opens the conversation", async () => {
    const box = (await row(second).boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(row(third)).toHaveClass(/selected/);
    await expect(row(second)).not.toHaveClass(/selected/);
    expect(await conversationIds(page, host.projectDir)).toEqual([second, third, first]);
  });

  await test.step("Esc cancels a drag", async () => {
    await dragOnto(page, row(first), row(second), "top");
    await expect(row(second)).toHaveClass(/drop-before/);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(row(second)).not.toHaveClass(/drop-before/);
    expect(await conversationIds(page, host.projectDir)).toEqual([second, third, first]);
  });

  await page.getByRole("button", { name: "Add workspace" }).click();
  await page.getByLabel("Workspace directory").fill(secondDir);
  await page.getByLabel("Workspace directory").press("Enter");
  await expect(workspaceCard(page, secondDir)).toBeVisible();
  await workspaceCard(page, secondDir).getByRole("button", { name: "+ New conversation" }).click();
  await expect(workspaceCard(page, secondDir).locator("li[data-reorder-id]")).toHaveCount(1);
  const [projectId, secondId] = await workspaceIds(page);
  const heading = (directory: string) => workspaceCard(page, directory).locator("header");

  await test.step("a conversation dragged over another workspace stays in its own, at its end", async () => {
    await dragOnto(page, row(second), workspaceCard(page, secondDir), "bottom");
    await page.mouse.up();
    await expect.poll(() => conversationIds(page, host.projectDir)).toEqual([third, first, second]);
    await expect(workspaceCard(page, secondDir).locator("li[data-reorder-id]")).toHaveCount(1);
  });

  await test.step("a workspace dragged by its heading above another moves there, and stays after a reload", async () => {
    await dragOnto(page, heading(secondDir), heading(host.projectDir), "top");
    await expect(workspaceCard(page, host.projectDir)).toHaveClass(/drop-before/);
    await page.mouse.up();
    await expect.poll(() => workspaceIds(page)).toEqual([secondId, projectId]);
    await page.reload();
    await expect.poll(() => workspaceIds(page)).toEqual([secondId, projectId]);
  });
});
