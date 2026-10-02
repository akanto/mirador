import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, createProfile, sendMessage, signIn, startConversation, waitForTurnToEnd } from "./helpers.ts";
import { ScriptedModel, scriptedOpencodeEnvironment } from "./scripted-model.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5100);
const model = new ScriptedModel();
const PROFILE = "scripted opencode";

test.beforeAll(async () => {
  await model.start();
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  model.stop();
});

test("a subagent's work folds into its card, and the header counts the subagents still at work", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const dialog = await createProfile(page, PROFILE, scriptedOpencodeEnvironment(model, host.root), "", "opencode");
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${PROFILE} · opencode` });
  const conversationId = await startConversation(page);
  await sendMessage(page, "hello");
  await waitForTurnToEnd(page);

  await host.stop();
  execFileSync("bun", [join(import.meta.dirname, "seed-subagents.ts"), join(host.dataDir, "state.sqlite"), conversationId]);
  await host.start();
  await page.reload();

  const cards = page.locator(".timeline .tool.subagent");
  const [explore, watch] = [cards.nth(0), cards.nth(1)];
  const chip = page.locator(".chat-header .subagents-running");

  await test.step("each subagent is one card with what it is, and what it did is inside it", async () => {
    await expect(cards).toHaveCount(2);
    await expect(explore.locator(".subagent-task")).toHaveText("Explore the cache");
    await expect(explore.locator(".subagent-facts")).toHaveText("Explore · haiku · 2 calls · 39 s");
    await expect(explore).toHaveClass(/subagent-done/);
    await expect(watch.locator(".subagent-facts")).toContainText("sonnet · 1 call · ");
    await expect(watch.locator(".subagent-facts")).toContainText("in the background");
    await expect(page.locator(".timeline .tool:not(.subagent)", { hasText: "Read host/cache.ts" })).toHaveCount(1);
    await expect(explore.locator(".subagent-work .tool", { hasText: "Read host/cache.ts" })).toBeAttached();
    await expect(page.locator(".message.agent", { hasText: "Both subagents are on it." })).toBeVisible();
    await expect(page.locator(".message.agent", { hasText: "The cache lives in host/cache.ts." })).toBeHidden();
    await explore.locator("summary").first().click();
    await expect(explore.locator(".subagent-work .message.agent")).toHaveText("The cache lives in host/cache.ts.");
    await expect(explore.locator(".tool-output").last()).toHaveText("Report: the cache is in host/cache.ts.");
  });

  await test.step("while the turn is open the background subagent counts as running; it is done when the turn ends", async () => {
    await expect(watch).toHaveClass(/subagent-stopped/);
    await expect(chip).toHaveCount(0);
    await sendMessage(page, "RUN echo still-going");
    await expect(page.locator(".permission.pending")).toBeVisible({ timeout: 60_000 });
    await expect(chip).toHaveText("◐ 1 subagent running");
    await expect(watch).toHaveClass(/subagent-running/);
    await expect(watch.locator(".subagent-now")).toHaveText("now: bun run build");
    await page.locator(".timeline").evaluate((timeline) => timeline.scrollTo(0, 0));
    await chip.click();
    await expect(watch).toBeInViewport();
    await page.locator(".permission.pending button.option-allow_once").click();
    await waitForTurnToEnd(page);
    await expect(chip).toHaveCount(0);
    await expect(watch).toHaveClass(/subagent-done/);
  });
});
