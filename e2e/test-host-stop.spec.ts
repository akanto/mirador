import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(4895);
const LATE_WRITER_SECONDS = 2;

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("stop waits for what the host started, so nothing writes into the test root after cleanUp removed it", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  await startConversation(page);
  await page.getByRole("button", { name: "Show terminal" }).click();
  await page.locator(".terminal-pane .xterm").click();
  const lateWrite = join(host.root, "written-after-the-host-stopped");
  await page.keyboard.type(`w=started; (trap '' HUP TERM; echo "late-writer-$w"; sleep ${LATE_WRITER_SECONDS}; mkdir -p '${lateWrite}') &\n`);
  await expect(page.locator(".terminal-pane .xterm-rows")).toContainText("late-writer-started");

  await host.stop();
  await host.cleanUp();
  await new Promise((resolve) => setTimeout(resolve, (LATE_WRITER_SECONDS + 1) * 1000));
  expect(existsSync(host.root)).toBe(false);
});
