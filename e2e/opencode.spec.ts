import { spawn } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { agentEnvironment } from "../host/acp/environment.ts";
import { applyEnvironment, parseEnvironment } from "../shared/profile-environment.ts";
import { addWorkspace, createProfile, lastAgentMessage, sendMessage, signIn, startConversation, waitForTurnToEnd } from "./helpers.ts";
import { ScriptedModel, scriptedOpencodeEnvironment } from "./scripted-model.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(4840);
const model = new ScriptedModel();
const PROFILE = "scripted opencode";
const MARKER = "opencode-terminal-marker-17";

/**
 * What a user does in a terminal: `opencode run` in the project directory, with the same isolated opencode setup.
 * opencode takes the session directory from $PWD, which a shell sets and a spawned child otherwise inherits from its parent.
 */
async function runOpencodeInTerminal(prompt: string) {
  const isolated = applyEnvironment(agentEnvironment(), parseEnvironment(scriptedOpencodeEnvironment(model, host.root)));
  const env = { ...isolated, PWD: host.projectDir };
  const opencode = spawn("opencode", ["run", "--model", "e2e/scripted", prompt], { cwd: host.projectDir, env, stdio: "ignore" });
  const exitCode = await new Promise((resolve) => opencode.once("exit", resolve));
  expect(exitCode).toBe(0);
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await model.start();
  await host.start();
  await runOpencodeInTerminal(`${MARKER}: remember the number 17`);
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  model.stop();
});

const innerOverflowOf = (frame: Locator) =>
  frame.contentFrame().locator("html").evaluate((html) => html.scrollHeight - html.clientHeight);

async function chooseScriptedOpencode(page: Page) {
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${PROFILE} · opencode` });
}

test("an opencode conversation asks for permission in the browser and uses the canvas tools", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const dialog = await createProfile(page, PROFILE, scriptedOpencodeEnvironment(model, host.root), "", "opencode");
  await dialog.getByRole("button", { name: "Close" }).click();
  await chooseScriptedOpencode(page);
  await startConversation(page);
  await expect(page.locator(".chat-header .harness")).toHaveText("opencode");
  await expect(page.getByLabel("Profile", { exact: true }).locator("option:checked")).toHaveText(PROFILE);
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("e2e/scripted");

  await sendMessage(page, "RUN echo e2e-bash-output");
  const permission = page.locator(".permission.pending");
  await expect(permission).toBeVisible({ timeout: 60_000 });
  await permission.locator("button.option-allow_once").click();
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText("Tool result: e2e-bash-output");

  await sendMessage(page, "SHOW Scripted page");
  await expect(page.frameLocator(".canvas-frame.show iframe").locator("h1")).toHaveText("Scripted page", { timeout: 60_000 });
  await waitForTurnToEnd(page);

  await sendMessage(page, "ASK Pick a color");
  const context = page.locator(".canvas-frame.ask-context iframe");
  await expect(context.contentFrame().locator("h2")).toHaveText("Why this matters", { timeout: 60_000 });
  await expect.poll(() => innerOverflowOf(context)).toBe(0);
  expect((await context.boundingBox())!.height).toBeGreaterThan(600);
  const preview = page.locator(".canvas-frame.ask-preview iframe");
  await expect.poll(() => innerOverflowOf(preview)).toBe(0);
  expect((await preview.boundingBox())!.height).toBeLessThan(200);
  await page.getByRole("button", { name: "Choose “Blue”" }).click();
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText("Blue");
});

test("continuing an opencode session from a terminal gives the agent its earlier context", async ({ page }) => {
  await signIn(page, host);
  await expect(page.getByLabel("Agent", { exact: true })).toHaveValue(/.+/);
  await chooseScriptedOpencode(page);
  await page.getByRole("button", { name: "Continue a session…" }).click();
  const dialog = page.getByRole("dialog", { name: "Continue a session" });
  await expect(dialog).toContainText("opencode sessions started in");
  const terminalSession = dialog.locator(".session-list li", { has: page.getByRole("button", { name: "Continue" }) });
  await expect(terminalSession).toHaveCount(1, { timeout: 30_000 });
  await terminalSession.getByRole("button", { name: "Continue" }).click();

  await expect(page.locator(".timeline")).toContainText(MARKER, { timeout: 30_000 });
  await sendMessage(page, "What did I ask you to remember?");
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText("Echo: What did I ask you to remember?");
  const lastRequest = model.requests.at(-1)!;
  expect(JSON.stringify(lastRequest.messages)).toContain(MARKER);
});

test("an opencode conversation moves to another opencode profile and keeps its context", async ({ page }) => {
  await signIn(page, host);
  const saved = await createProfile(page, "scripted opencode 2", scriptedOpencodeEnvironment(model, host.root), "", "opencode");
  await saved.getByRole("button", { name: "Close" }).click();
  await page.locator(".workspace li", { hasText: "RUN echo e2e-bash-output" }).click();
  await page.getByLabel("Profile", { exact: true }).selectOption({ label: "scripted opencode 2" });
  await expect(page.locator(".timeline")).toContainText("Now using the profile “scripted opencode 2”");

  await sendMessage(page, "after the switch");
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText("Echo: after the switch");
  expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain("Pick a color");
  await expect(page.locator(".timeline")).not.toContainText("Could not resume");
});

test("with YOLO on, tools run without asking, and switching it on approves the request already waiting", async ({ page }) => {
  await signIn(page, host);
  await chooseScriptedOpencode(page);
  await startConversation(page);
  const yolo = page.getByLabel("YOLO", { exact: true });
  await expect(yolo).not.toBeChecked();

  await sendMessage(page, "RUN echo approved-by-yolo");
  await expect(page.locator(".permission.pending")).toBeVisible({ timeout: 60_000 });
  await yolo.click();
  await expect(yolo).toBeChecked();
  await expect(lastAgentMessage(page)).toContainText("Tool result: approved-by-yolo", { timeout: 60_000 });
  await waitForTurnToEnd(page);

  await sendMessage(page, "RUN echo no-questions-asked");
  await expect(lastAgentMessage(page)).toContainText("Tool result: no-questions-asked", { timeout: 60_000 });
  await expect(page.locator(".permission")).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel("YOLO", { exact: true })).toBeChecked();
});
