import { expect, test } from "@playwright/test";
import { addWorkspace, callCanvasTool, openFromCanvasHistory, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5360);

test.describe.configure({ mode: "serial" });

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("several questions come one page at a time, can be changed on a review page, and are answered together", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const ask = page.locator(".ask");
  const next = ask.getByRole("button", { name: "Next" });
  const toolResult = callCanvasTool(host, conversationId, "ask", {
    questions: [
      { question: "Which color?", options: [{ label: "Red" }, { label: "Blue" }] },
      { question: "Which size?", options: [{ label: "Small" }, { label: "Large" }], allowOther: true },
    ],
  });

  await expect(ask.getByRole("heading", { name: "Which color?" })).toBeVisible();
  await expect(ask).toContainText("Question 1 of 2");
  await expect(ask.getByRole("button", { name: "Back" })).toBeDisabled();
  await expect(next).toBeDisabled();
  await ask.getByRole("radio", { name: "Red", exact: true }).check();
  await next.click();

  await expect(ask.getByRole("heading", { name: "Which size?" })).toBeVisible();
  await expect(ask).toContainText("Question 2 of 2");
  await expect(ask.getByRole("button", { name: "Submit" })).toHaveCount(0);

  await test.step("leaving the conversation and coming back keeps the page and the answers", async () => {
    await startConversation(page);
    await page.goto(`${host.origin}/#/c/${conversationId}`);
    await expect(ask.getByRole("heading", { name: "Which size?" })).toBeVisible();
    await ask.getByRole("button", { name: "Back" }).click();
    await expect(ask.getByRole("radio", { name: "Red", exact: true })).toBeChecked();
    await next.click();
  });

  await test.step("Shift+Enter starts a new line of your own answer, and Enter goes on to the next page", async () => {
    const ownAnswer = ask.getByRole("textbox", { name: "Your own answer" });
    await ask.getByRole("textbox", { name: /note/i }).fill("fits the wall");
    await ownAnswer.pressSequentially("Huge");
    await ownAnswer.press("Shift+Enter");
    await ownAnswer.pressSequentially("and round");
    await expect(ownAnswer).toHaveValue("Huge\nand round");
    await expect(ownAnswer).toHaveAttribute("rows", "2");
    await ownAnswer.press("Enter");
  });

  await test.step("the review page lists every answer, and Change goes back to its question", async () => {
    await expect(ask).toContainText("Review your answers");
    await expect(ask.locator(".ask-review li")).toHaveText([/Which color\?\s*Red/, /Which size\?\s*Huge\s*and round\s*— “fits the wall”/]);
    expect(await ask.locator(".ask-review strong").last().innerText()).toBe("Huge\nand round");
    await ask.locator(".ask-review li").first().getByRole("button", { name: "Change" }).click();
    await ask.getByRole("radio", { name: "Blue", exact: true }).check();
    await next.click();
    await next.click();
    await expect(ask.locator(".ask-review li").first()).toContainText("Blue");
  });

  await ask.getByRole("button", { name: "Submit" }).click();
  expect(await toolResult).toBe(
    ["The user answered 2 questions:", "1. Which color?", "   The user chose: Blue", "2. Which size?", "   The user chose: Huge\nand round", "   Their note: fits the wall"].join("\n"),
  );
  await expect(page.locator(".settled-note")).toHaveText("✓ Answer sent: “Blue · Huge and round”");
});

test("your own answer to one question can run over several lines with Shift+Enter, and Enter sends it", async ({ page }) => {
  await signIn(page, host);
  await page.goto(host.origin);
  const conversationId = await startConversation(page);
  const ask = page.locator(".ask");
  const toolResult = callCanvasTool(host, conversationId, "ask", { question: "What should it say?", options: [{ label: "Hello" }, { label: "Goodbye" }], allowOther: true });
  const ownAnswer = ask.getByRole("textbox", { name: "Your own answer" });

  await test.step("the field takes the row beside its radio button", async () => {
    const row = (await ask.locator(".ask-other").boundingBox())!;
    const field = (await ownAnswer.boundingBox())!;
    expect(field.x - row.x).toBeLessThan(40);
    expect(field.x + field.width).toBeCloseTo(row.x + row.width, 0);
  });

  await ownAnswer.pressSequentially("First line");
  await ownAnswer.press("Shift+Enter");
  await ownAnswer.pressSequentially("Second line");
  await expect(ask.getByRole("radio", { name: "Something else" })).toBeChecked();
  await expect(ownAnswer).toHaveValue("First line\nSecond line");
  await ownAnswer.press("Enter");

  expect(await toolResult).toBe("The user chose: First line\nSecond line");
  await openFromCanvasHistory(page, "What should it say?");
  expect(await ask.locator(".ask-answer strong").innerText()).toBe("First line\nSecond line");
});

test("the ask tool advertises one question or several, tells the agent to ask several with questions, and neither form is required alone", async ({ page }) => {
  await signIn(page, host);
  await page.goto(host.origin);
  const conversationId = await startConversation(page);
  const response = await fetch(`${host.origin}/mcp/${conversationId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${host.mcpToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await response.text();
  const message = JSON.parse(
    body
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length) ?? body,
  );
  const ask = message.result.tools.find(({ name }: { name: string }) => name === "ask");
  expect(Object.keys(ask.inputSchema.properties)).toEqual(expect.arrayContaining(["question", "options", "questions"]));
  expect(ask.inputSchema.required ?? []).toEqual([]);
  expect(ask.inputSchema.properties.questions.items.required).toEqual(expect.arrayContaining(["question", "options"]));
  expect(ask.inputSchema.properties.questions).toMatchObject({ minItems: 2, maxItems: 10 });
  expect(ask.description).toContain("When you have two or more things to ask, pass questions");
  expect(ask.description).toContain("never offer options such as \"Accept all\"");

  expect(await callCanvasTool(host, conversationId, "ask", { question: "Only a question" })).toContain("Give question and options, or questions");
  const oneQuestion = { question: "Q", options: [{ label: "A" }, { label: "B" }] };
  const both = { ...oneQuestion, questions: [oneQuestion, oneQuestion] };
  expect(await callCanvasTool(host, conversationId, "ask", both)).toContain("not both");
  expect(await callCanvasTool(host, conversationId, "ask", { html: "<p>context</p>", questions: [oneQuestion, oneQuestion] })).toContain("on each question");
});
