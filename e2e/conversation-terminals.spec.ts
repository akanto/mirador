import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5365, { shell: "/bin/sh" });

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const screen = (page: Page) => page.locator(".terminal-pane .xterm-rows");
const tabs = (page: Page) => page.locator(".terminal-pane").getByRole("tab");

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function runInTerminal(page: Page, command: string) {
  await page.locator(".terminal-pane .xterm").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

test("each conversation of a workspace has terminals of its own, which keep running while another conversation is shown and close when it is deleted", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const first = await startConversation(page);
  await page.getByRole("button", { name: "Show terminal" }).click();
  await runInTerminal(page, "MARK=first-shell; echo first-$((20+1))");
  await expect(screen(page)).toContainText("first-21");

  const second = await startConversation(page);
  await page.getByRole("button", { name: "Show terminal" }).click();
  await expect(tabs(page)).toHaveCount(1);
  await runInTerminal(page, "pwd; echo mark-${MARK:-unset} shell-$$");
  await expect(screen(page)).toContainText("mark-unset");
  const secondShell = Number((await screen(page).textContent())!.match(/mark-unset shell-(\d+)/)![1]);
  await expect(screen(page)).toContainText("/project");
  await expect(screen(page)).not.toContainText("first-21");

  await page.goto(`${host.origin}/#/c/${first}`);
  await expect(screen(page)).toContainText("first-21");
  await expect(tabs(page)).toHaveCount(1);
  await runInTerminal(page, "echo mark-$MARK");
  await expect(screen(page)).toContainText("mark-first-shell");

  await page.goto(`${host.origin}/#/c/${second}`);
  expect(isRunning(secondShell)).toBe(true);
  const deleteButton = page.locator(".workspace li.selected").getByRole("button", { name: "Delete conversation" });
  await deleteButton.click();
  await deleteButton.click();
  await expect.poll(() => isRunning(secondShell)).toBe(false);
});
