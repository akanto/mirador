import { expect, test } from "@playwright/test";
import { addWorkspace, callCanvasTool, signIn, startConversation } from "./helpers.ts";
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

  await ask.getByRole("textbox", { name: "Your own answer" }).fill("Huge");
  await ask.getByRole("textbox", { name: /note/i }).fill("fits the wall");
  await next.click();

  await test.step("the review page lists every answer, and Change goes back to its question", async () => {
    await expect(ask).toContainText("Review your answers");
    await expect(ask.locator(".ask-review li")).toHaveText([/Which color\?\s*Red/, /Which size\?\s*Huge\s*— “fits the wall”/]);
    await ask.locator(".ask-review li").first().getByRole("button", { name: "Change" }).click();
    await ask.getByRole("radio", { name: "Blue", exact: true }).check();
    await next.click();
    await next.click();
    await expect(ask.locator(".ask-review li").first()).toContainText("Blue");
  });

  await ask.getByRole("button", { name: "Submit" }).click();
  expect(await toolResult).toBe(
    ["The user answered 2 questions:", "1. Which color?", "   The user chose: Blue", "2. Which size?", "   The user chose: Huge", "   Their note: fits the wall"].join("\n"),
  );
  await expect(page.locator(".settled-note")).toHaveText("✓ Answer sent: “Blue · Huge”");
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
});
