import { expect, test } from "@playwright/test";
import { addWorkspace, openSettings, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost();

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("inside the desktop app, a refused microphone says to allow it when the app asks, and where the system allows it", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    window.__electrobunSendToHost = (message) => {
      if (message.type === "desktop-nonce-request") setTimeout(() => window.dispatchEvent(new CustomEvent("mirador:desktop-nonce", { detail: "nonce-1" })));
    };
    // What the app's webview answers once the user blocks the microphone in its dialog.
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  await startConversation(page);
  const settings = await openSettings(page, "Voice");
  const recognition = settings.getByRole("group", { name: "Speech recognition" });
  await recognition.getByLabel("Turns speech into text").selectOption({ label: "With a server of your own" });
  await recognition.getByLabel("Address").fill("http://127.0.0.1:9/v1");
  await recognition.getByLabel("Model").fill("whisper-turbo");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByRole("status")).toHaveText("Saved.");
  await settings.getByRole("button", { name: "Close" }).click();

  await page.locator(".composer:visible").getByRole("button", { name: "Dictate" }).click();
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const systemSetting = userAgent.includes("Mac")
    ? " and in System Settings → Privacy & Security → Microphone"
    : userAgent.includes("Windows")
      ? " and in Windows Settings → Privacy & security → Microphone, which desktop apps need too"
      : "";
  await expect(page.locator(".composer-area:visible .composer-problem")).toHaveText(
    `Mirador may not use the microphone. Allow it when the desktop app asks${systemSetting}. Blocking it in the app holds until the app quits.`,
  );
  await expect(page.locator(".composer-area:visible .dictation-status")).toHaveCount(0);
});
