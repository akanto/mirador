import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, createProfile, sendMessage, signIn, startConversation, waitForTurnToEnd } from "./helpers.ts";
import { ScriptedModel, scriptedOpencodeEnvironment } from "./scripted-model.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(4940, { runsUserStatusLine: true });
const model = new ScriptedModel();
const PROFILE = "statusline opencode";

/** Claude settings of the test's own, whose statusline prints what Claude Code's JSON and the profile environment gave it. */
function claudeSettingsWithStatusline() {
  const configDir = join(host.root, "claude-config");
  mkdirSync(configDir, { recursive: true });
  const script = join(configDir, "statusline.ts");
  writeFileSync(
    script,
    [
      "const input = JSON.parse(await Bun.stdin.text());",
      "const used = input.context_window.used_percentage ?? 'none';",
      "console.log(`\\x1b[1;32m${input.model.display_name}\\x1b[0m context ${used} ${process.env.STATUSLINE_MARKER} cols ${process.env.COLUMNS}`);",
    ].join("\n"),
  );
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: `bun ${script}` } }));
  return configDir;
}

test.beforeAll(async () => {
  await model.start();
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  model.stop();
});

test("the statusline command from the profile's Claude settings replaces the built-in statusline, and the user can switch back", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const environment = `${scriptedOpencodeEnvironment(model, host.root)}\nCLAUDE_CONFIG_DIR=${claudeSettingsWithStatusline()}\nSTATUSLINE_MARKER=from-the-profile`;
  const dialog = await createProfile(page, PROFILE, environment, "", "opencode");
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${PROFILE} · opencode` });
  await startConversation(page);

  const statusline = page.getByRole("region", { name: "Statusline" });
  const printed = statusline.locator(".statusline-terminal");
  await expect(printed).toHaveAttribute("aria-label", /context none from-the-profile cols \d+$/);
  await expect(printed.locator(".xterm-rows")).toContainText("from-the-profile");

  await sendMessage(page, "hello");
  await waitForTurnToEnd(page);
  await expect(printed).toHaveAttribute("aria-label", /context 42 from-the-profile/);

  await statusline.getByRole("button", { name: "Built-in" }).click();
  await expect(printed).toHaveCount(0);
  await expect(statusline.locator(".context-meter")).toHaveText("42% · 42k / 100k");
  await page.reload();
  await expect(statusline.locator(".context-meter")).toBeVisible();
  await statusline.getByRole("button", { name: "Your statusline" }).click();
  await expect(printed).toHaveAttribute("aria-label", /context 42 from-the-profile/);
});
