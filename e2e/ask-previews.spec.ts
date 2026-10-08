import { expect, test, type Locator } from "@playwright/test";
import { addWorkspace, answerCanvasQuestion, callCanvasTool, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(4850);

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const mockup = (width: number) =>
  `<div style="width:${width}px;display:flex;justify-content:space-between;background:#eef;padding:8px"><b>START</b><b>END</b></div>`;
const fluid = (text: string) => `<p style="margin:8px">${text}</p>`;

/** The agent waits on its question until it is answered, so the call is left running. */
const askInBackground = (conversationId: string, ask: Record<string, unknown>) => void callCanvasTool(host, conversationId, "ask", ask).catch(() => {});

const preview = (option: Locator) => option.locator("iframe");

async function expectWhollyShown(frame: Locator) {
  await expect(frame.contentFrame().getByText("END")).toBeInViewport({ ratio: 1 });
}

test("previews show whole: option columns widen to fit them, and what is wider than the canvas is scaled down", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 1000 });
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const options = page.locator(".ask-option");

  askInBackground(conversationId, {
    question: "Which look?",
    html: mockup(900),
    options: [
      { label: "Small", html: fluid("fits anywhere") },
      { label: "Sidebar", html: mockup(300) },
      { label: "Page", html: mockup(700) },
    ],
  });
  await expect(options).toHaveCount(3);
  await expectWhollyShown(page.locator(".ask-context iframe"));
  await expectWhollyShown(preview(options.nth(1)));
  await expectWhollyShown(preview(options.nth(2)));
  await expect(preview(options.nth(1))).not.toHaveAttribute("style", /scale/);
  await expect(preview(options.nth(2))).toHaveAttribute("style", /scale/);
  await answerCanvasQuestion(page, "Sidebar");

  askInBackground(conversationId, {
    question: "Which colour?",
    options: [
      { label: "Green", html: fluid("green") },
      { label: "Blue", html: fluid("blue") },
    ],
  });
  await expect(options.first()).toHaveText(/Green/);
  const [green, blue] = await Promise.all([options.nth(0).boundingBox(), options.nth(1).boundingBox()]);
  expect(blue!.y).toBe(green!.y);
});

test("a long unbroken word wraps inside its option and the question's page, rather than running past the box or shrinking the page", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await signIn(page, host);
  const conversationId = await startConversation(page);
  const identifier = "AvailabilityChecker.doesAllImageSucceedForEveryInstanceGroupOfTheStackWhenItsMetadataIsReadLazily";
  askInBackground(conversationId, {
    question: "Which fix?",
    html: `<div style="border:1px solid #888;border-radius:8px;padding:12px">Note: <code>${identifier}</code> reads the lazy collection.</div>`,
    options: [{ label: "Fix the checker", description: `Change ${identifier} to read instance metadata.` }, { label: "Leave it" }],
  });

  const option = page.locator(".ask-option").first();
  await expect(option).toContainText(identifier);
  expect(await option.evaluate((box) => box.scrollWidth <= box.clientWidth)).toBe(true);
  const context = page.locator(".ask-context iframe");
  await expect(context.contentFrame().getByText(identifier)).toBeVisible();
  await expect(context, "the page has reported its size").toHaveAttribute("style", /height/);
  await expect(context).not.toHaveAttribute("style", /scale/);
  await answerCanvasQuestion(page, "Leave it");
});

test("a question's page and previews taller than the window show whole, so a wheel turn over them scrolls the canvas toward the answer", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await signIn(page, host);
  const conversationId = await startConversation(page);
  const tall = (text: string) => `<div style="height:1500px;background:#151922;color:#e3e7ef">${text}</div>`;
  askInBackground(conversationId, { question: "Which plan?", html: tall("The plan"), options: [{ label: "Go" }, { label: "Wait", html: tall("Waiting") }] });

  const context = page.locator(".ask-context iframe");
  const scrollsInside = (frame: Locator) => frame.contentFrame().locator("html").evaluate((root) => root.scrollHeight > root.clientHeight);
  await expect(context.contentFrame().getByText("The plan")).toBeVisible();
  await expect.poll(() => scrollsInside(context)).toBe(false);
  await expect.poll(() => scrollsInside(preview(page.locator(".ask-option").nth(1)))).toBe(false);

  const canvas = page.locator(".canvas-body");
  const { x, y, width } = (await context.boundingBox())!;
  await page.mouse.move(x + width / 2, y + 100);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => canvas.evaluate((element) => element.scrollTop), "the page reports the turn, and the canvas takes it once").toBe(300);
  await answerCanvasQuestion(page, "Go");
});

test("a page that scrolls inside itself keeps the wheel, and the canvas takes the turns the page cannot use", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await signIn(page, host);
  const conversationId = await startConversation(page);
  const scrollsItself = `<div style="height:1500px;background:#151922;color:#e3e7ef">
  <div id="inner" style="height:200px;overflow-y:auto"><div style="height:1000px">inside the box</div></div>
  <div style="height:1000px">below the box</div>
</div>`;
  askInBackground(conversationId, { question: "Which plan?", html: scrollsItself, options: [{ label: "Go" }, { label: "Wait" }] });

  const context = page.locator(".ask-context iframe");
  const insideThePage = context.contentFrame();
  const inner = insideThePage.locator("#inner");
  const canvas = page.locator(".canvas-body");
  await expect(inner).toBeVisible();
  const scrollTop = () => canvas.evaluate((element) => element.scrollTop);

  await test.step("a box inside the page keeps the wheel, and the canvas stays where it is", async () => {
    const box = (await inner.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 50);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => inner.evaluate((element) => element.scrollTop)).toBe(200);
    expect(await scrollTop()).toBe(0);
  });

  await test.step("a turn the page cannot use reaches the canvas", async () => {
    const below = (await insideThePage.getByText("below the box").boundingBox())!;
    await page.mouse.move(below.x + below.width / 2, below.y + 20);
    await page.mouse.wheel(0, 200);
    await expect.poll(scrollTop).toBe(200);
  });

  await answerCanvasQuestion(page, "Go");
});

test("a question asked right after a page carries that page, so both are in the canvas together", async ({ page }) => {
  await signIn(page, host);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "show", { title: "Decision explained", html: fluid("Markers own resources; names only locate them.") });
  askInBackground(conversationId, { question: "Which doctrine?", options: [{ label: "Markers own" }, { label: "Names own" }] });

  const carried = page.getByRole("region", { name: "Shown before the question: Decision explained" });
  await expect(carried.locator("iframe").contentFrame().getByText("Markers own resources")).toBeVisible();
  await expect(page.locator(".ask h3")).toHaveText("Which doctrine?");
  await answerCanvasQuestion(page, "Markers own");

  askInBackground(conversationId, { question: "And the next one?", options: [{ label: "Yes" }, { label: "No" }] });
  await expect(page.locator(".ask h3")).toHaveText("And the next one?");
  await expect(page.locator(".ask-page-before")).toHaveCount(0);
});
