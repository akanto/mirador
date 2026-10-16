import { realpathSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, answerCanvasQuestion, createProfile, lastAgentMessage, sendMessage, signIn, startConversation, waitForTurnToEnd } from "./helpers.ts";
import { ScriptedModel, forgetPiAcpSessionsUnder, piProgram, scriptedPiEnvironment } from "./scripted-model.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost();
const model = new ScriptedModel();
const PROFILE = "scripted pi";
let page: Page;

test.describe.configure({ mode: "serial" });
test.skip(piProgram() === null, "pi is not installed");
test.beforeAll(async ({ browser }) => {
  await model.start();
  await host.start();
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
  await host.stop();
  forgetPiAcpSessionsUnder(realpathSync(host.root));
  forgetPiAcpSessionsUnder(host.root);
  await host.cleanUp();
  model.stop();
});

const canvasHeading = () => page.frameLocator(".canvas-frame.show iframe").locator("h1");

test("a pi conversation replies, runs commands and uses the canvas tools", async () => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const dialog = await createProfile(page, PROFILE, scriptedPiEnvironment(model, host.root), "", "pi");
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${PROFILE} · pi` });
  await startConversation(page);
  await expect(page.locator(".chat-header:visible .harness")).toHaveText("pi");

  await sendMessage(page, "Hello pi");
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText("Echo: Hello pi");
  await expect(page.locator(".message.agent")).toHaveCount(1);

  await sendMessage(page, "RUN printenv PI_ACP_MCP_SERVERS || echo no-canvas-servers-in-env");
  await waitForTurnToEnd(page);
  await expect(page.locator(".shell-output").last()).toHaveText("no-canvas-servers-in-env");

  await sendMessage(page, "SHOW Scripted page");
  await expect(canvasHeading()).toHaveText("Scripted page", { timeout: 60_000 });
  await waitForTurnToEnd(page);

  await sendMessage(page, "ASK Pick a color");
  await answerCanvasQuestion(page, "Blue");
  await expect(page.locator(".settled-note")).toHaveText("✓ Answer sent: “Blue”");
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText("Blue");
});

test("a second pi conversation on the same profile leaves the first one working", async () => {
  await startConversation(page);
  await expect(page.locator(".chat-header:visible .harness")).toHaveText("pi");
  await sendMessage(page, "SHOW Second page");
  await expect(canvasHeading()).toHaveText("Second page", { timeout: 60_000 });
  await waitForTurnToEnd(page);

  await page.locator(".workspace li", { hasText: "Hello pi" }).click();
  await sendMessage(page, "Still there?");
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText("Echo: Still there?");
});

test("after a host restart, a pi conversation goes on in its own session with the canvas tools", async () => {
  await host.restart();
  await expect(page.locator(".banner")).toHaveCount(0, { timeout: 30_000 });
  await sendMessage(page, "SHOW After restart");
  await expect(canvasHeading()).toHaveText("After restart", { timeout: 60_000 });
  await waitForTurnToEnd(page);
  expect(model.userMessagesInContext()).toEqual(expect.arrayContaining(["Hello pi", "Still there?", "SHOW After restart"]));
});
