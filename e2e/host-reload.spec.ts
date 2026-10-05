import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { isHostCommandLine } from "../desktop/src/core/host-command.ts";
import { addWorkspace, sendMessage, signIn, startConversation, waitForTurnToEnd } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5010, { copiesSource: true });

test.describe.configure({ mode: "serial" });
test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

function editSource(file: string, from: string, to: string) {
  const path = join(host.sourceDir, file);
  const source = readFileSync(path, "utf8");
  expect(source.split(from)).toHaveLength(2);
  writeFileSync(path, source.split(from).join(to));
}

const primaryModifier = async (page: Page) => ((await page.evaluate(() => navigator.userAgent.includes("Mac"))) ? "Meta" : "Control");

const commandLineOf = (pid: number) => execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();

test("Cmd+R serves the UI as it is now; Cmd+Shift+R restarts the host in place, and a working agent continues afterwards", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const hostCodeChanged = page.locator(".banner.host-code-changed");

  await test.step("an edit to the UI shows after Cmd+R, and the host keeps running its code", async () => {
    editSource("web/App.tsx", "<h2>No conversation selected</h2>", "<h2>No conversation selected, edited</h2>");
    const primary = await primaryModifier(page);
    await expect(async () => {
      await page.keyboard.press(`${primary}+R`);
      await expect(page.getByRole("heading", { name: "No conversation selected, edited" })).toBeVisible({ timeout: 2_000 });
    }, "the watcher hears about the edit a moment after it is written").toPass({ timeout: 20_000 });
    await expect(hostCodeChanged).toHaveCount(0);
  });

  await test.step("an edit to the host's code offers a restart", async () => {
    appendFileSync(join(host.sourceDir, "host/main.ts"), "\n// edited by the e2e test\n");
    await expect(hostCodeChanged).toContainText("The host's code changed since it started.");
  });

  await startConversation(page);
  const yolo = page.getByLabel("YOLO", { exact: true });
  await yolo.click();
  await expect(yolo).toBeChecked();
  await sendMessage(page, "Run the shell command `sleep 20; echo slept-through-restart` with your Bash tool, then reply with what it printed.");
  await expect(page.locator(".timeline").locator(".tool-pending, .tool-in_progress").first()).toBeVisible({ timeout: 120_000 });
  const composer = page.locator(".composer textarea");
  await composer.fill("queued before the restart");
  await composer.press("Enter");
  await expect(page.locator(".queue .queued-text")).toHaveText(["queued before the restart"]);

  await test.step("Cmd+Shift+R stops the turn and restarts the host in the same process, with the same command line", async () => {
    const pid = host.pid!;
    expect(isHostCommandLine(commandLineOf(pid))).toBe(true);
    await page.keyboard.press(`${await primaryModifier(page)}+Shift+R`);
    await expect.poll(() => host.log.match(/Mirador is running/g)?.length, { timeout: 60_000 }).toBe(2);
    expect(host.pid).toBe(pid);
    expect(isHostCommandLine(commandLineOf(pid))).toBe(true);
    await expect(hostCodeChanged).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(".timeline")).toContainText("Turn ended: cancelled");
  });

  await test.step("the agent continues where it left off, then the queued message goes out", async () => {
    await expect(page.locator(".message.user", { hasText: "Continue where you left off." })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".message.user").last()).toHaveText("queued before the restart", { timeout: 180_000 });
    await expect(page.locator(".timeline .shell-output", { hasText: "slept-through-restart" }).first()).toBeAttached();
    await waitForTurnToEnd(page);
    await expect(page.locator(".timeline")).not.toContainText("Could not resume");
  });
});

test("a host stopped from outside, like the tray's Restart, keeps the queued messages and sends them once it is back", async ({ page }) => {
  await signIn(page, host);
  await startConversation(page);
  const yolo = page.getByLabel("YOLO", { exact: true });
  await yolo.click();
  await expect(yolo).toBeChecked();
  await sendMessage(page, "Run the shell command `sleep 30` with your Bash tool, then reply with the single word SLEPT.");
  await expect(page.locator(".timeline").locator(".tool-pending, .tool-in_progress").first()).toBeVisible({ timeout: 120_000 });
  const composer = page.locator(".composer textarea");
  await composer.fill("Reply with just the word QUEUED.");
  await composer.press("Enter");
  await expect(page.locator(".queue .queued-text")).toHaveText(["Reply with just the word QUEUED."]);

  await host.restart();
  await expect(page.locator(".message.user").last()).toHaveText("Reply with just the word QUEUED.", { timeout: 60_000 });
  await expect(page.locator(".queue .queued-text")).toHaveCount(0);
  await waitForTurnToEnd(page);
  await expect(page.locator(".message.agent").last()).toContainText("QUEUED");
});
