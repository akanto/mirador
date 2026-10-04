import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, chooseInSettings, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5236);

test.beforeAll(async () => {
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const shellCommand = (toolCallId: string, description: string, command: string, status: "completed" | "failed", output: string) => ({
  type: "acp",
  update: {
    sessionUpdate: "tool_call",
    toolCallId,
    title: command,
    kind: "execute",
    status,
    rawInput: { command, description },
    content: [{ type: "content", content: { type: "text", text: output } }],
  },
});

const checkedTheBuild = [
  { type: "user-message", text: "Check the build" },
  shellCommand("toolu_tests", "Run the unit tests", "bun test", "completed", "12 pass"),
  shellCommand("toolu_types", "Type check", "bunx tsc --noEmit", "failed", "error TS2322"),
  { type: "turn-end", stopReason: "end_turn" },
];

test("a shell command the agent ran shows what ran with its output a click away, unless Settings show it another way", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await host.stop();
  execFileSync("bun", [join(import.meta.dirname, "seed-events.ts"), join(host.dataDir, "state.sqlite"), conversationId, JSON.stringify(checkedTheBuild)]);
  await host.start();
  await page.reload();
  const card = (description: string) => page.locator(".timeline .shell", { hasText: description });
  const tests = card("Run the unit tests");
  const typeCheck = card("Type check");

  await test.step("each starts with its command and without its output, and a click shows the output", async () => {
    await expect(tests.locator(".shell-typed")).toHaveText("bun test");
    await expect(tests.locator(".shell-output")).toBeHidden();
    await expect(typeCheck.locator(".shell-exit")).toBeVisible();
    await expect(typeCheck.locator(".shell-output")).toBeHidden();
    await tests.locator("summary").click();
    await expect(tests.locator(".shell-output")).toHaveText("12 pass");
    const command = (await tests.locator("summary").boundingBox())!;
    const output = (await tests.locator(".shell-body.below-command").boundingBox())!;
    expect(output.y).toBeCloseTo(command.y + command.height, 0);
  });

  await test.step("output open when it failed opens the failed command", async () => {
    await chooseInSettings(page, "Shell commands", "Command, output open when it failed");
    await expect(typeCheck.locator(".shell-output")).toHaveText("error TS2322");
    await expect(typeCheck.locator(".shell-output")).toBeVisible();
  });

  await test.step("one line keeps the command a click away too", async () => {
    await chooseInSettings(page, "Shell commands", "One line");
    await expect(typeCheck.locator(".shell-description")).toBeVisible();
    await expect(typeCheck.locator(".shell-typed")).toBeHidden();
    await typeCheck.locator("summary").click();
    await expect(typeCheck.locator(".shell-typed")).toHaveText("bunx tsc --noEmit");
  });

  await test.step("command and output shows everything, as before", async () => {
    await chooseInSettings(page, "Shell commands", "Command and output");
    await page.reload();
    await expect(tests.locator(".shell-output")).toBeVisible();
    await expect(typeCheck.locator(".shell-output")).toBeVisible();
  });
});
