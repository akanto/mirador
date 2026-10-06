import { expect, test } from "@playwright/test";
import { addWorkspace, callCanvasTool, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5296);

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const tallPage = `<body style="margin:0;background:#0d1117"><div style="height:2400px;color:#f0f6fc">
  <p>top of the page</p>
  <p style="margin-top:2000px">bottom of the page</p>
</div></body>`;

test("a wheel turn over a canvas page scrolls the page, once", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "show", { title: "Tall", html: tallPage });

  const canvasPage = page.locator(".canvas-frame.show iframe");
  await expect(canvasPage).toBeVisible();
  const box = (await canvasPage.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 200);

  const inside = page.locator(".canvas-frame.show iframe").contentFrame().locator("body");
  await expect.poll(() => inside.evaluate((node) => node.ownerDocument.scrollingElement!.scrollTop)).toBe(200);
});
