import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5460);

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const informational = (text: string, level = "notice") => ({
  type: "acp",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, _meta: { claudeCode: { kind: "informational", level } } },
});

const compactionContext = ["<persisted-output>", "Recent context, needle in it", "", "Mode: code"].map((line) => `SessionStart:compact says: ${line}`).join("\n");

const turn = [
  { type: "user-message", text: "carry on" },
  informational(`**Notice:** ${compactionContext}`),
  informational("**Notice:** Stop says: all checks passed"),
  informational("**Warning:** PreToolUse:Bash says: rm -rf was blocked", "warning"),
  informational("**Notice:** Context left until *auto-compact*: 10%"),
  { type: "acp", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Carrying on." } } },
  { type: "turn-end", stopReason: "end_turn" },
];

test("a hook's message shows the hook's name once and folds away when it runs over a line", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await host.stop();
  execFileSync("bun", [join(import.meta.dirname, "seed-events.ts"), join(host.dataDir, "state.sqlite"), conversationId, JSON.stringify(turn)]);
  await host.start();
  await page.reload();

  const hookMessages = page.locator(".timeline .hook-message");
  const folded = hookMessages.nth(0);
  const lines = folded.locator(".hook-lines");
  await expect(page.locator(".message.agent")).toContainText("Carrying on.");

  await test.step("a message of several lines is one line naming the hook, folded", async () => {
    await expect(folded.locator("summary")).toHaveText("SessionStart:compact hook · 4 lines");
    await expect(lines).toBeHidden();
  });

  await test.step("unfolded, it shows each line on its own, without the hook's name before it", async () => {
    await folded.locator("summary").click();
    await expect(lines).toBeVisible();
    expect(await lines.innerText()).toBe("<persisted-output>\nRecent context, needle in it\n\nMode: code");
    await folded.locator("summary").click();
    await expect(lines).toBeHidden();
  });

  await test.step("a message of one line shows in full, naming a level stronger than a notice", async () => {
    await expect(hookMessages.nth(1)).toHaveText("Stop hook: all checks passed");
    await expect(hookMessages.nth(2)).toHaveText("Warning: PreToolUse:Bash hook: rm -rf was blocked");
    await expect(hookMessages).toHaveCount(3);
  });

  await test.step("a notice that is not a hook's still shows as before", async () => {
    const notice = page.locator(".timeline .info-line:not(.hook-message)");
    await expect(notice).toHaveText("Notice: Context left until auto-compact: 10%");
    await expect(notice.locator("strong")).toHaveText("Notice:");
  });

  await test.step("find unfolds the message where it matches", async () => {
    await page.keyboard.press("Control+KeyF");
    await page.getByRole("search").getByLabel("Find in this conversation").fill("needle");
    await expect(page.getByRole("search").locator(".find-tally")).toHaveText("1 of 1");
    await expect(lines).toBeVisible();
  });
});
