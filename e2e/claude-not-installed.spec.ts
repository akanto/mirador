import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, openSettings, signIn } from "./helpers.ts";
import { scratchPath, TestHost } from "./test-host.ts";

const scratch = scratchPath("claude-not-installed");
const homeWithoutClaude = join(scratch, "home");
const programs = join(scratch, "programs");
const bunDir = dirname(execFileSync("which", ["bun"], { encoding: "utf8" }).trim());
const host = new TestHost({ environment: { HOME: homeWithoutClaude, PATH: [programs, bunDir, "/usr/bin", "/bin"].join(":") } });
const installedLater = join(programs, "claude");

test.beforeAll(async () => {
  mkdirSync(homeWithoutClaude, { recursive: true });
  mkdirSync(programs, { recursive: true });
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  rmSync(scratch, { recursive: true, force: true });
});

test("Settings says how to install Claude Code, and finds it once it is installed", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);

  await test.step("with no claude anywhere, it gives this computer's install command", async () => {
    const settings = await openSettings(page, "Agents");
    await expect(settings.locator(".claude-program-found")).toHaveText(
      "Claude Code is not installed. Install it with curl -fsSL https://claude.ai/install.sh | bash, or enter where its claude program is.",
    );
  });

  await test.step("installed while the host runs, it is found when the page opens again", async () => {
    writeFileSync(installedLater, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
    chmodSync(installedLater, 0o755);
    await page.reload();
    const settings = await openSettings(page, "Agents");
    await expect(settings.locator(".claude-program-found")).toHaveText(`Runs ${installedLater}, 9.9.9 (Claude Code)`);
  });
});
