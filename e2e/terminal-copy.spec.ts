import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, openSettings, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5232);

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

/** Records what the page copies instead of writing it, so a run on macOS leaves the system clipboard alone. */
const recordCopies = (page: Page) =>
  page.addInitScript(() => {
    const copied: string[] = [];
    Object.assign(window, { copied });
    navigator.clipboard.writeText = async (text: string) => void copied.push(text);
  });
const copied = (page: Page) => page.evaluate(() => (window as unknown as { copied: string[] }).copied);
const lastCopied = async (page: Page) => (await copied(page)).at(-1);

test("with copy on select switched on in Settings → Terminal, selecting text in a terminal copies it", async ({ page }) => {
  await recordCopies(page);
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  await startConversation(page);
  await page.getByRole("button", { name: "Show terminal" }).click();
  const screen = page.locator(".terminal-pane .xterm-rows");
  await page.locator(".terminal-pane .xterm").click();
  await page.keyboard.type("echo copy-$((5+5)) and-more\n");
  await expect(screen).toContainText("copy-10 and-more");
  const row = (await screen.locator(":scope > div", { hasText: /^copy-10 and-more\s*$/ }).boundingBox())!;
  const onTheWord = { x: row.x + 20, y: row.y + row.height / 2 };

  await test.step("off by default: selecting copies nothing", async () => {
    await page.mouse.dblclick(onTheWord.x, onTheWord.y);
    await page.waitForTimeout(300);
    expect(await copied(page)).toEqual([]);
  });

  await test.step("switched on, a double-clicked word and a triple-clicked line are copied as the mouse is released", async () => {
    const settings = await openSettings(page, "Terminal");
    await settings.getByLabel("Copy on select").check();
    await page.keyboard.press("Escape");
    await page.mouse.dblclick(onTheWord.x, onTheWord.y);
    await expect.poll(() => copied(page)).toEqual(["copy-10"]);
    await page.mouse.click(onTheWord.x, onTheWord.y, { clickCount: 3 });
    await expect.poll(() => lastCopied(page)).toBe("copy-10 and-more");
  });

  await test.step("a drag copies what it covers; a plain click copies nothing", async () => {
    await page.mouse.move(row.x + 1, onTheWord.y);
    await page.mouse.down();
    await page.mouse.move(onTheWord.x + 10, onTheWord.y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => lastCopied(page)).toMatch(/^copy-?1?$/);
    const copiesBefore = (await copied(page)).length;
    await page.mouse.click(onTheWord.x, onTheWord.y);
    await page.waitForTimeout(300);
    expect(await copied(page)).toHaveLength(copiesBefore);
  });

  await test.step("the setting is remembered in this browser", async () => {
    await page.reload();
    await expect((await openSettings(page, "Terminal")).getByLabel("Copy on select")).toBeChecked();
  });
});
