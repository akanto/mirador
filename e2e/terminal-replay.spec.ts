import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5290, { shell: "/bin/sh" });

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const screens = (page: Page) => page.locator(".terminal-pane .xterm-rows");
const screenOf = (page: Page, index: number) => screens(page).nth(index);

/** What a program asks its terminal: where the cursor is, and what colour the background is. */
const queries = "\x1b[6n\x1b]11;?\x07";
const cursorPositionAnswer = /\[\d+;\d+R/;
const backgroundColourAnswer = /rgb:/;

test("replaying a terminal's log does not answer the questions in it as though the user had typed the answers", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  await startConversation(page);
  await page.getByRole("button", { name: "Show terminal" }).click();
  const terminal = page.locator(".terminal-pane .xterm");
  await expect(terminal).toHaveCount(1);

  const query = join(host.projectDir, "query");
  const reading = join(host.projectDir, "reading");
  await terminal.click();
  await page.keyboard.type(`while [ ! -f ${query} ]; do sleep 0.2; done; cat ${query}; echo REBUILT-FROM-LOG; stty raw -echo; touch ${reading}; cat -v\n`);

  await page.getByRole("button", { name: "New terminal tab" }).click();
  await expect(screens(page)).toHaveCount(1);
  writeFileSync(query, queries);
  await expect.poll(() => existsSync(reading)).toBe(true);

  await page.getByRole("tab", { name: "sh", exact: true }).click();
  await expect(screenOf(page, 0)).toContainText("REBUILT-FROM-LOG");
  await page.keyboard.type("MARKER\n");
  await expect(screenOf(page, 0)).toContainText("MARKER");

  const shown = (await screenOf(page, 0).textContent())!;
  expect(shown).not.toMatch(cursorPositionAnswer);
  expect(shown).not.toMatch(backgroundColourAnswer);

  await test.step("a question a program asks now, on a terminal the reader is looking at, is still answered", async () => {
    await page.getByRole("button", { name: "New terminal tab" }).click();
    await expect(screens(page)).toHaveCount(1);
    await page.locator(".terminal-pane .xterm").click();
    await page.keyboard.type(`stty raw -echo; cat ${query}; cat -v\n`);
    await expect(screenOf(page, 0)).toContainText(cursorPositionAnswer);
  });
});
