import { expect, test } from "@playwright/test";
import { FakeGateway, gatewayEnvironment } from "./fake-gateway.ts";
import { addWorkspace, createProfile, sendMessage, signIn, startConversation, waitForTurnToEnd } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(4900);
const gateway = new FakeGateway();

test.beforeAll(async () => {
  await gateway.start();
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  gateway.stop();
});

test("each line shows its time while pointed at, or always once timestamps are switched on", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const dialog = await createProfile(page, "fake gateway", gatewayEnvironment(gateway));
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "fake gateway · Claude Code" });
  await startConversation(page);
  await sendMessage(page, "what time is it");
  await expect(page.locator(".timeline")).toContainText("fake gateway says no", { timeout: 60_000 });
  await waitForTurnToEnd(page);

  const timestamps = page.locator(".timeline .timestamp");
  const userLine = page.locator(".timeline-entry", { has: page.locator(".message.user") });
  const userLineTime = userLine.locator(".timestamp");
  await expect(timestamps.first()).toBeHidden();
  const agentLine = page.locator(".timeline-entry", { has: page.locator(".message.agent") }).first();
  const indentOf = async () => (await agentLine.locator(".entry-body").boundingBox())!.x - (await agentLine.boundingBox())!.x;
  expect(await indentOf()).toBe(0);
  await userLine.locator(".message.user").hover();
  await expect(userLineTime).toBeVisible();
  await expect(userLineTime).toHaveText(/^\d\d:\d\d$/);
  await expect(userLineTime).toHaveAttribute("title", new RegExp(String(new Date().getFullYear())));
  await page.locator(".chat-header h2").hover();
  await expect(userLineTime).toBeHidden();

  const toggle = page.getByLabel("Show timestamps");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  expect(await indentOf()).toBeGreaterThan(20);
  expect(await timestamps.count()).toBeGreaterThan(1);
  for (const timestamp of await timestamps.all()) await expect(timestamp).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Show timestamps")).toBeChecked();
  await expect(userLineTime).toBeVisible();
  await page.getByLabel("Show timestamps").uncheck();
  await expect(userLineTime).toBeHidden();
  expect(await indentOf()).toBe(0);
});
