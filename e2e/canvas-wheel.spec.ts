import { expect, test } from "@playwright/test";
import { addWorkspace, callCanvasTool, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5296);

// Later tests use the workspace the first one adds.
test.describe.configure({ mode: "serial" });
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

const boxInTallPage = `<body style="margin:0">
  <div id="box" style="height:300px;overflow:auto;margin-top:100px"><div style="height:2000px">inside the box</div></div>
  <div style="height:2400px">rest of the page</div>
</body>`;

test("a wheel turn over a scrolling box in a tall page scrolls the box, not the page as well", async ({ page }) => {
  await signIn(page, host);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "show", { title: "Box", html: boxInTallPage });

  const inside = page.locator(".canvas-frame.show iframe").contentFrame().locator("body");
  const box = (await inside.locator("#box").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 200);

  const scrolled = () =>
    inside.evaluate((node) => ({ box: node.ownerDocument.getElementById("box")!.scrollTop, page: node.ownerDocument.scrollingElement!.scrollTop }));
  await expect.poll(scrolled).toEqual({ box: 200, page: 0 });
  await page.waitForTimeout(200);
  expect(await scrolled()).toEqual({ box: 200, page: 0 });
});
