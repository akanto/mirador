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
