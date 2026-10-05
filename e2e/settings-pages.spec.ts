import { expect, test } from "@playwright/test";
import { openSettings, signIn } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5226);

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("Settings shows one page at a time, chosen from the list on the left by click or with Up and Down", async ({ page }) => {
  await signIn(page, host);
  const settings = await openSettings(page);
  const pages = settings.getByRole("tablist", { name: "Settings pages" });
  const tab = (name: string) => pages.getByRole("tab", { name });

  await expect(pages.getByRole("tab")).toHaveText(["Appearance", "Conversations", "Agents", "Terminal", "Canvas", "Layout", "Devices", "Notifications"]);
  await expect(tab("Appearance")).toHaveAttribute("aria-selected", "true");
  await expect(settings.getByRole("radiogroup", { name: "Theme" })).toBeVisible();

  await tab("Devices").click();
  await expect(settings.getByRole("button", { name: "Invite a device" })).toBeVisible();
  await expect(settings.getByRole("radiogroup", { name: "Theme" })).toHaveCount(0);

  await page.keyboard.press("ArrowDown");
  await expect(tab("Notifications")).toBeFocused();
  await expect(tab("Notifications")).toHaveAttribute("aria-selected", "true");
  await expect(settings.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(tab("Appearance")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(tab("Devices")).toBeFocused();
  await expect(settings.getByRole("button", { name: "Invite a device" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await openSettings(page, "Layout");
  await expect(settings.getByRole("heading", { name: "Default layout" })).toBeVisible();
});
