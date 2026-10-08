import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FakeClaudeApi } from "./fake-claude-api.ts";
import { addWorkspace, openSettings, sendMessage, signIn, startConversation } from "./helpers.ts";
import { scratchPath, TestHost } from "./test-host.ts";

const api = new FakeClaudeApi();
const scratch = scratchPath("claude-program");
const installedClaude = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
const wrapperLog = join(scratch, "wrapper.log");
const wrapper = join(scratch, "claude-wrapper");
let host: TestHost;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  api.limited = false;
  await api.start();
  mkdirSync(scratch, { recursive: true });
  writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> "${wrapperLog}"\nexec "${installedClaude}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  host = new TestHost(5250, { environment: { ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_OAUTH_TOKEN: "e2e-subscription-token", CLAUDE_CODE_MAX_RETRIES: "0" } });
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  api.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("Mirador runs the Claude Code installed on the computer, or the program set in Settings, and says when there is none", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const settings = await openSettings(page, "Agents");
  const program = settings.getByLabel("Program");
  const found = settings.locator(".claude-program-found");

  await test.step("with nothing set, it finds claude on PATH and shows its version", async () => {
    await expect(program).toHaveValue("");
    await expect(found).toHaveText(new RegExp(`^Runs ${installedClaude}, \\d+\\.\\d+\\.\\d+ \\(Claude Code\\)$`));
  });

  await test.step("a program set in Settings is the one conversations run", async () => {
    await program.fill(wrapper);
    await program.press("Enter");
    await expect(found).toHaveText(new RegExp(`^Runs ${wrapper}, \\d+\\.\\d+\\.\\d+ \\(Claude Code\\)$`));
    await settings.getByRole("button", { name: "Close" }).click();
    await startConversation(page);
    await sendMessage(page, "Which program runs you?");
    await expect(page.locator(".message.agent").last()).toHaveText("Answered: Which program runs you?", { timeout: 60_000 });
    expect(existsSync(wrapperLog) && readFileSync(wrapperLog, "utf8")).toContain("--output-format stream-json");
  });

  await test.step("a program that is not there is reported in Settings and in the conversation", async () => {
    const missing = join(scratch, "no-such-claude");
    const reopened = await openSettings(page, "Agents");
    await reopened.getByLabel("Program").fill(missing);
    await reopened.getByLabel("Program").press("Enter");
    await expect(reopened.locator(".claude-program-found")).toHaveText("Nothing at that path can run.");
    await reopened.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "+ New conversation" }).click();
    await expect(page.locator(".chat-header:visible .status-detail")).toContainText(`The Claude Code program set in Settings › Agents, ${missing}, does not exist or cannot run.`, { timeout: 30_000 });
  });

  await test.step("emptied, it finds claude on its own again", async () => {
    const reopened = await openSettings(page, "Agents");
    await reopened.getByLabel("Program").fill("");
    await reopened.getByLabel("Program").press("Enter");
    await expect(reopened.locator(".claude-program-found")).toHaveText(new RegExp(`^Runs ${installedClaude}, `));
  });
});
