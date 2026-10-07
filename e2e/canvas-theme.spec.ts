import { expect, test } from "@playwright/test";
import { addWorkspace, callCanvasTool, chooseInSettings, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5297);

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

// The page sets no colours itself: the wrapper's default light-dark() background has to follow the panel.
const barePage = "<body><p>plain page</p></body>";

const wrapperBackground = (page: import("@playwright/test").Page) =>
  page
    .locator(".canvas-frame.show iframe")
    .contentFrame()
    .locator("body")
    .evaluate((node) => getComputedStyle(node.ownerDocument.documentElement).backgroundColor);

test("a canvas page's default background follows the panel theme, live", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "show", { title: "Plain", html: barePage });

  await expect.poll(() => wrapperBackground(page)).toBe("rgb(255, 255, 255)");
  await chooseInSettings(page, "Theme", "Dark");
  await expect.poll(() => wrapperBackground(page)).toBe("rgb(17, 17, 17)");
});
