import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, answerCanvasQuestion, createProfile, lastAgentMessage, sendMessage, signIn, startConversation, waitForTurnToEnd } from "./helpers.ts";
import { ScriptedModel, forgetPiAcpSessionsUnder, piProgram, scriptedPiEnvironment } from "./scripted-model.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost();
const model = new ScriptedModel();
const PROFILE = "scripted pi";
const SLOW_PROFILE = "slow scripted pi";
const SLOW_PI_START_SECONDS = 3;
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
const CANVAS_RENDERING_RULES = "Rendering environment: every page renders in a sandboxed iframe with NO network access";
const OWN_APPENDED_INSTRUCTIONS = "Instructions from the user's own APPEND_SYSTEM.md";

/** Each profile has its pi-acp, which runs one pi for each session it has open; pi renames its process, so they are told by their parent. */
function piSessionProcesses() {
  const processes = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .map(([pid, parentPid, ...command]) => ({ pid: Number(pid), parentPid: Number(parentPid), command: command.join(" ") }));
  const piAcps = new Set(processes.filter(({ parentPid, command }) => parentPid === host.pid && command.includes("pi-acp")).map(({ pid }) => pid));
  return processes.filter(({ parentPid }) => piAcps.has(parentPid));
}

test("a pi conversation replies, runs commands and uses the canvas tools", async () => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const dialog = await createProfile(page, PROFILE, scriptedPiEnvironment(model, host.root), "", "pi");
  writeFileSync(join(host.root, "pi-agent", "APPEND_SYSTEM.md"), OWN_APPENDED_INSTRUCTIONS);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${PROFILE} · pi` });
  await startConversation(page);
  await expect(page.locator(".chat-header:visible .harness")).toHaveText("pi");

  await sendMessage(page, "Hello pi");
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText("Echo: Hello pi");
  await expect(page.locator(".message.agent")).toHaveCount(1);
  expect(model.systemPromptInContext()).toContain(CANVAS_RENDERING_RULES);
  expect(model.systemPromptInContext()).toContain(OWN_APPENDED_INSTRUCTIONS);
  expect(model.toolDescription("when_done")).toContain("Have Mirador wait for a job you leave running");

  await sendMessage(page, "RUN printenv PI_ACP_SESSION || echo no-canvas-servers-in-env");
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

test("deleting a pi conversation in the middle of a turn ends its pi process quietly, and the other one goes on", async () => {
  await expect.poll(piSessionProcesses).toHaveLength(2);
  await page.locator(".workspace li", { hasText: "Second page" }).click();
  await sendMessage(page, "ASK Pick a size");
  await expect(page.locator(".ask")).toBeVisible({ timeout: 60_000 });
  const deleteButton = page.locator(".workspace li.selected").getByRole("button", { name: "Delete conversation" });
  await deleteButton.click();
  await expect(deleteButton).toHaveText("Delete?");
  await deleteButton.click();
  await expect(page.locator(".workspace li", { hasText: "Second page" })).toHaveCount(0);
  await expect.poll(piSessionProcesses).toHaveLength(1);
  await page.waitForTimeout(1_000);
  await expect(page.locator(".notice")).toHaveCount(0);

  await page.locator(".workspace li", { hasText: "Hello pi" }).click();
  await sendMessage(page, "After the delete");
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText("Echo: After the delete");
});

test("deleting a pi conversation while its session opens ends the pi that session starts", async () => {
  const slowPi = join(host.root, "slow-pi");
  writeFileSync(slowPi, `#!/bin/sh\nsleep ${SLOW_PI_START_SECONDS}\nexec '${piProgram()}' "$@"\n`, { mode: 0o755 });
  const dialog = await createProfile(page, SLOW_PROFILE, `${scriptedPiEnvironment(model, host.root)}\nPI_ACP_PI_COMMAND=${slowPi}`, "", "pi");
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${SLOW_PROFILE} · pi` });
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page.locator(".chat-header:visible h2")).toHaveText("New conversation");
  await expect.poll(piSessionProcesses).toHaveLength(2);

  const deleteButton = page.locator(".workspace li.selected").getByRole("button", { name: "Delete conversation" });
  await deleteButton.click();
  await deleteButton.click();
  await expect(page.locator(".workspace li")).toHaveCount(1);
  await expect.poll(piSessionProcesses, { timeout: (SLOW_PI_START_SECONDS + 20) * 1_000 }).toHaveLength(1);
  await expect(page.locator(".notice")).toHaveCount(0);
  await page.locator(".workspace li", { hasText: "Hello pi" }).click();
});

test("after a host restart, a pi conversation goes on in its own session with the canvas tools", async () => {
  await host.restart();
  await expect(page.locator(".banner")).toHaveCount(0, { timeout: 30_000 });
  await sendMessage(page, "SHOW After restart");
  await expect(canvasHeading()).toHaveText("After restart", { timeout: 60_000 });
  await waitForTurnToEnd(page);
  expect(model.userMessagesInContext()).toEqual(expect.arrayContaining(["Hello pi", "Still there?", "SHOW After restart"]));
  expect(model.systemPromptInContext()).toContain(CANVAS_RENDERING_RULES);
});
