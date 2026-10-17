import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, createProfile, sendMessage, signIn, waitForTurnToEnd } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost({ fakePrograms: true });

test.beforeAll(async () => {
  mkdirSync(host.fakeProgramsDir, { recursive: true });
  writeFileSync(
    join(host.fakeProgramsDir, "opencode"),
    `#!/bin/sh\nFAKE_ACP_PROMPTS='${join(host.root, "prompts")}' exec bun '${join(import.meta.dirname, "fake-acp-agent.ts")}' "$@"\n`,
  );
  chmodSync(join(host.fakeProgramsDir, "opencode"), 0o755);
  mkdirSync(host.projectDir, { recursive: true });
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("another agent's error in Claude Code's words for a usage limit is an error, not Claude's usage limit", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, "words alone", "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "words alone · opencode" });
  await page.getByRole("button", { name: "+ New conversation" }).click();

  await sendMessage(page, "FAIL You've hit your session limit · resets 11:20pm (Europe/Budapest)");
  await waitForTurnToEnd(page);
  await expect(page.locator(".error-line")).toContainText("You've hit your session limit");
  await expect(page.locator(".usage-limit-line")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Usage limit" })).toHaveCount(0);
});
