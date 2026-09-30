import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(4760);

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const widthOf = (page: Page, selector: string) => page.locator(selector).evaluate((element) => element.getBoundingClientRect().width);

async function dragSplitterBy(page: Page, deltaX: number) {
  const box = (await page.locator(".splitter").boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 10 });
  await page.mouse.up();
}

test("chat and canvas can be resized, stay above a minimum width and remember the split", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "show", { title: "Big", html: "<div style='height:2000px'>canvas</div>" });
  await expect(page.locator(".canvas-frame.show iframe")).toBeVisible();

  const canvasBefore = await widthOf(page, ".canvas-panel");
  await dragSplitterBy(page, 300);
  const canvasAfterDraggingOverIframe = await widthOf(page, ".canvas-panel");
  expect(canvasBefore - canvasAfterDraggingOverIframe).toBeGreaterThan(250);

  await dragSplitterBy(page, 5000);
  expect(await widthOf(page, ".canvas-panel")).toBeGreaterThanOrEqual(239);
  await dragSplitterBy(page, -5000);
  expect(await widthOf(page, ".chat-column")).toBeGreaterThanOrEqual(239);
  const chatAtMinimum = await widthOf(page, ".chat-column");

  await page.reload();
  await expect(page.locator(".splitter")).toBeVisible();
  expect(Math.abs((await widthOf(page, ".chat-column")) - chatAtMinimum)).toBeLessThan(2);

  await page.locator(".splitter").dblclick();
  expect(Math.abs((await widthOf(page, ".canvas-panel")) - canvasBefore)).toBeLessThan(2);
});

test.describe("on a system in dark mode", () => {
  test.use({ colorScheme: "dark" });
  const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const LIGHT = "rgb(255, 255, 255)";
  const DARK = "rgb(18, 19, 23)";

  test("the theme is light unless the user picks dark or matching the system, and the choice is remembered", async ({ page }) => {
    await signIn(page, host);
    expect(await background(page)).toBe(LIGHT);
    await page.getByLabel("Theme").selectOption("dark");
    expect(await background(page)).toBe(DARK);
    await page.reload();
    await expect(page.getByLabel("Theme")).toHaveValue("dark");
    expect(await background(page)).toBe(DARK);
    await page.getByLabel("Theme").selectOption("system");
    expect(await background(page)).toBe(DARK);
    await page.getByLabel("Theme").selectOption("light");
    expect(await background(page)).toBe(LIGHT);
  });
});
