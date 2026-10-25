import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, openSettings, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost();

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const imagesInReplies = {
  title: "Images",
  sections: [
    {
      items: [
        { id: "chart", text: "Chart", detail: "![build chart](https://images.invalid/chart.png)" },
        { id: "badge", text: "Badge", detail: "[![build](https://badges.invalid/build.svg)](https://ci.invalid/run/1)" },
        { id: "unnamed", text: "Unnamed", detail: "![](https://images.invalid/unnamed.png)" },
        { id: "inline", text: "Inline", detail: `![dot](${ONE_PIXEL_PNG})` },
      ],
    },
  ],
};

async function openChecklist(page: Page) {
  const toggle = page.locator(".checklist-toggle:visible");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
}

const checklistView = (page: Page) => page.frameLocator(".checklist:visible .canvas-frame.plugin iframe");
const detailOf = (page: Page, text: string) => checklistView(page).locator(".checklist-item", { hasText: text }).locator(".checklist-detail");

/** Loads an image from another site the way the page would, and says whether the page's policy refused it. */
const refusedByPolicy = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        let refused = false;
        document.addEventListener("securitypolicyviolation", (event) => (refused ||= event.blockedURI.includes("probe.invalid")));
        const image = new Image();
        image.onerror = () => setTimeout(() => resolve(refused), 300);
        image.src = `https://probe.invalid/${crypto.randomUUID()}.png`;
      }),
  );

test("images from other sites in an agent's Markdown show as links naming the site until Settings lets them load", async ({ page }) => {
  const requestsToOtherSites: string[] = [];
  page.on("request", (request) => new URL(request.url()).hostname.endsWith(".invalid") && requestsToOtherSites.push(request.url()));
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "checklist", imagesInReplies);

  await test.step("by default each shows as a link to the image, named for its site, and nothing is fetched from that site", async () => {
    const chart = detailOf(page, "Chart").getByRole("link", { name: "build chart (image from images.invalid)" });
    await expect(chart).toHaveAttribute("href", "https://images.invalid/chart.png");
    await expect(detailOf(page, "Unnamed").getByRole("link", { name: "Image from images.invalid" })).toBeVisible();
    await expect(detailOf(page, "Chart").locator("img")).toHaveCount(0);
    await expect(detailOf(page, "Inline").locator("img")).toBeVisible();
    expect(requestsToOtherSites).toEqual([]);
  });

  await test.step("a badge keeps its own link, with the image named inside it rather than a second link", async () => {
    const badge = detailOf(page, "Badge").getByRole("link");
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveAttribute("href", "https://ci.invalid/run/1");
    await expect(badge).toHaveText("build (image from badges.invalid)");
  });

  await test.step("the page itself refuses an image from another site, whatever renders it", async () => {
    expect(await refusedByPolicy(page)).toBe(true);
  });

  await test.step("Settings lets them load from the next reload on", async () => {
    const settings = await openSettings(page, "Conversations");
    const asLinks = settings.getByRole("checkbox", { name: "Show images from other sites as links" });
    await expect(asLinks).toBeChecked();
    await asLinks.uncheck();
    await expect(settings.getByText("They load after a reload.")).toBeVisible();
    await expect(detailOf(page, "Chart").locator("img")).toHaveCount(0);
    const chartRequested = page.waitForRequest("https://images.invalid/chart.png");
    await settings.getByRole("button", { name: "Reload" }).click();
    await openChecklist(page);
    await chartRequested;
    await expect(detailOf(page, "Chart").locator("img")).toHaveAttribute("src", "https://images.invalid/chart.png");
    await expect(detailOf(page, "Chart").locator("img")).toHaveAttribute("alt", "build chart");
    expect(await refusedByPolicy(page)).toBe(false);
  });

  await test.step("turning it back on shows them as links again at once", async () => {
    const settings = await openSettings(page, "Conversations");
    await settings.getByRole("checkbox", { name: "Show images from other sites as links" }).check();
    await expect(settings.getByText("They load after a reload.")).toHaveCount(0);
    await settings.getByRole("button", { name: "Close" }).click();
    await expect(detailOf(page, "Chart").getByRole("link", { name: "build chart (image from images.invalid)" })).toBeVisible();
    expect(await refusedByPolicy(page)).toBe(true);
  });
});
