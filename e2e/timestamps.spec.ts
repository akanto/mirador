import { expect, test } from "@playwright/test";
import { FakeGateway, gatewayEnvironment } from "./fake-gateway.ts";
import { addWorkspace, createProfile, openSettings, sendMessage, signIn, startConversation, waitForTurnToEnd } from "./helpers.ts";
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

test("each author's name carries the time; later lines show theirs while pointed at, or always once timestamps are switched on", async ({
  page,
}) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const dialog = await createProfile(page, "fake gateway", gatewayEnvironment(gateway));
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "fake gateway · Claude Code" });
  await startConversation(page);
  await sendMessage(page, "what time is it");
  await expect(page.locator(".timeline")).toContainText("fake gateway says no", { timeout: 60_000 });
  await waitForTurnToEnd(page);

  const userLine = page.locator(".timeline-entry", { has: page.locator(".message.user") });
  const userLineTime = userLine.locator(".author .timestamp");
  await expect(userLine.locator(".author")).toContainText("You");
  await expect(userLineTime).toBeVisible();
  await expect(userLineTime).toHaveText(/^\d\d:\d\d$/);
  await expect(userLineTime).toHaveAttribute("title", new RegExp(String(new Date().getFullYear())));
  await expect(page.locator(".timeline-entry", { has: page.locator(".message.agent") }).locator(".author")).toContainText("Claude");

  const laterLine = page.locator(".timeline-entry", { has: page.locator(".error-line") });
  const laterLineTime = laterLine.locator(".gutter .timestamp");
  await expect(laterLine).not.toHaveClass(/group-start/);
  await expect(laterLineTime).toBeHidden();
  const indentOf = async () => (await laterLine.locator(".entry-body").boundingBox())!.x - (await laterLine.boundingBox())!.x;
  const indentWithTimeHidden = await indentOf();
  await laterLine.hover();
  await expect(laterLineTime).toBeVisible();
  await expect(laterLineTime).toHaveText(/^\d\d:\d\d$/);
  await page.locator(".chat-header h2").hover();
  await expect(laterLineTime).toBeHidden();

  const toggle = page.getByLabel("Show timestamps");
  await openSettings(page);
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.keyboard.press("Escape");
  await expect(laterLineTime).toBeVisible();
  expect(await indentOf()).toBe(indentWithTimeHidden);
  await page.reload();
  await expect(laterLineTime).toBeVisible();
  await openSettings(page);
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.keyboard.press("Escape");
  await expect(laterLineTime).toBeHidden();
});
