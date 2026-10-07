import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, chooseInSettings, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5297);

// Later tests use the workspace the first one adds.
test.describe.configure({ mode: "serial" });
test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const white = "rgb(255, 255, 255)";
const nearBlack = "rgb(17, 17, 17)";

/** Sets no colours itself, and notes what its first paint shows while it is still parsing. */
const barePage = `<body><p>plain page</p><script>
  window.whileParsing = { background: getComputedStyle(document.documentElement).backgroundColor, colorScheme: getComputedStyle(document.documentElement).colorScheme };
</script></body>`;

/** The usual light-dark() recipe, which on its own follows the system. */
const pageFollowingTheSystem = `<style>:root { color-scheme: light dark; } body { margin: 0; background: light-dark(rgb(250, 250, 250), rgb(5, 5, 5)); }</style>
<body><p>own colours</p><script>window.whileParsing = { background: getComputedStyle(document.body).backgroundColor };</script></body>`;

const canvasPage = (page: Page) => page.locator(".canvas-frame.show iframe").contentFrame().locator("body");
const rootBackground = (page: Page) => canvasPage(page).evaluate((node) => getComputedStyle(node.ownerDocument.documentElement).backgroundColor);
const frameBackground = (page: Page) => page.locator(".canvas-frame.show iframe").evaluate((frame) => getComputedStyle(frame).backgroundColor);
const whileParsing = (page: Page) => canvasPage(page).evaluate(() => (window as unknown as { whileParsing: unknown }).whileParsing);

async function showPage(page: Page, html: string) {
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "show", { title: "Page", html });
  await expect(canvasPage(page).locator("p")).toBeVisible();
}

test("a canvas page's default background follows the panel theme, live", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  await showPage(page, barePage);

  await expect.poll(() => rootBackground(page)).toBe(white);
  expect(await frameBackground(page)).toBe(white);
  await chooseInSettings(page, "Theme", "Dark");
  await expect.poll(() => rootBackground(page)).toBe(nearBlack);
  expect(await frameBackground(page)).toBe(nearBlack);
});

test("a canvas page is in the panel's theme from its first paint, and its scripts can read which", async ({ page }) => {
  await signIn(page, host);
  await chooseInSettings(page, "Theme", "Dark");
  await showPage(page, barePage);

  expect(await whileParsing(page)).toEqual({ background: nearBlack, colorScheme: "dark" });
});

test("the panel's theme wins over the system's, even for a page that asks for the system's", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signIn(page, host);
  await showPage(page, pageFollowingTheSystem);

  expect(await whileParsing(page)).toEqual({ background: "rgb(250, 250, 250)" });
});

test("under Match system, a canvas page follows the system as it switches", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signIn(page, host);
  await chooseInSettings(page, "Theme", "Match system");
  await showPage(page, barePage);

  await expect.poll(() => rootBackground(page)).toBe(white);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => rootBackground(page)).toBe(nearBlack);
});
