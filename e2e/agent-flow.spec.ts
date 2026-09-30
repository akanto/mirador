import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, lastAgentMessage, sendMessage, signIn, startConversation, waitForTurnToEnd } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(4720);
const CHOSEN_NAME = "Named by the user";
let page: Page;
const agentTitles: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  await host.start();
  page = await browser.newPage();
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      const update = JSON.parse(String(payload)).event?.event?.update;
      if (update?.sessionUpdate === "session_info_update" && update.title) agentTitles.push(update.title);
    }),
  );
});

test.afterAll(async () => {
  await page.close();
  await host.stop();
  await host.cleanUp();
});

test("starts a Claude Code conversation with the test model", async () => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  await startConversation(page);
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("haiku");
  await page.locator(".chat-header h2").getByText("New conversation").click();
  await page.getByLabel("Conversation name").fill(CHOSEN_NAME);
  await page.getByLabel("Conversation name").press("Enter");
  await expect(page.locator(".chat-header h2")).toHaveText(CHOSEN_NAME);
});

test("streams a reply and asks for permission in the browser", async () => {
  await sendMessage(page, 'Use your Write tool to create a file named hello.txt in the current directory whose content is the word "hi". Then reply with the single word DONE.');
  const permission = page.locator(".permission.pending");
  await expect(permission).toBeVisible({ timeout: 120_000 });
  await permission.locator("button.option-allow_once").click();
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText("DONE");
  expect(readFileSync(join(host.projectDir, "hello.txt"), "utf8")).toContain("hi");
});

test("keeps the name the user chose when Claude Code titles the session", async () => {
  await expect.poll(() => agentTitles.length, { timeout: 60_000 }).toBeGreaterThan(0);
  expect(agentTitles[0]).not.toBe(CHOSEN_NAME);
  await expect(page.locator(".chat-header h2")).toHaveText(CHOSEN_NAME);
});

test("shows a page and returns an ask answer as the tool result", async () => {
  await sendMessage(
    page,
    'Call the canvas show tool with title "Greeting" and html "<h1>Hello canvas</h1>". Then call the canvas ask tool with question "Pick a color" and the options Red and Blue. After you get my answer, reply with only the name of the color I picked.',
  );
  await page.getByRole("button", { name: "Choose “Blue”" }).click({ timeout: 120_000 });
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText("Blue");
  await expect(page.locator(".ask-answer")).toContainText("returned to the agent");

  await page.locator(".canvas-tab", { hasText: "Greeting" }).click();
  await expect(page.locator(".canvas-frame.show iframe").contentFrame().getByRole("heading", { name: "Hello canvas" })).toBeVisible();
});

test("keeps the history across a page refresh", async () => {
  await page.reload();
  await expect(page.locator(".message.user").first()).toContainText("hello.txt");
  await expect(page.locator(".canvas-tab", { hasText: "Pick a color" })).toBeVisible();
  await expect(lastAgentMessage(page)).toContainText("Blue");
});

test("resumes the agent session and canvas tools after a host restart", async () => {
  await host.restart();
  await expect(page.locator(".banner")).toHaveCount(0, { timeout: 30_000 });
  await page.getByLabel("Mode", { exact: true }).selectOption("acceptEdits");
  await sendMessage(
    page,
    'What color did I pick earlier? Call the canvas show tool with title "After restart" and html "<p>The color was X</p>" where X is that color, then reply with only the color.',
  );
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText("Blue");
  await expect(page.locator(".canvas-frame.show iframe").contentFrame().getByText("The color was Blue")).toBeVisible();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("haiku");
  await expect(page.getByLabel("Mode", { exact: true })).toHaveValue("acceptEdits");
});

test("delivers an answer as the next message when the conversation is set to", async () => {
  await page.getByLabel("Questions").selectOption("next-message");
  await sendMessage(page, 'Call the canvas ask tool with question "Pick a size" and the options Small and Large. Then end your turn.');
  const choose = page.getByRole("button", { name: "Choose “Large”" });
  await expect(choose).toBeVisible({ timeout: 120_000 });
  await waitForTurnToEnd(page);
  await choose.click();
  await expect(page.locator(".message.user").last()).toContainText('My answer to your question "Pick a size": Large');
  await expect(page.locator(".ask-answer")).toContainText("sent as your next message");
  await waitForTurnToEnd(page);
  expect(existsSync(join(host.dataDir, "state.sqlite"))).toBe(true);
});
