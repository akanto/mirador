import { expect, test } from "@playwright/test";
import { addWorkspace, sendMessage, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost();

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("a host killed in the middle of a turn comes back with that turn ended, not left working", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  await startConversation(page);
  const yolo = page.getByLabel("YOLO", { exact: true });
  await yolo.click();
  await expect(yolo).toBeChecked();
  await sendMessage(page, "Run the shell command `sleep 60` with your Bash tool, then reply with the single word SLEPT.");
  await expect(page.locator(".timeline").locator(".tool-pending, .tool-in_progress").first()).toBeVisible({ timeout: 120_000 });

  await host.kill();
  await host.start();

  await expect(page.locator(".timeline")).toContainText("Turn ended: cancelled", { timeout: 60_000 });
  await expect(page.locator(".working")).toHaveCount(0);
});
