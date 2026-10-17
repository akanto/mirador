import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, createProfile, signIn } from "./helpers.ts";
import { forgetPiAcpSessionsUnder } from "./scripted-model.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost();
const oldPi = join(host.root, "old-pi");
/** What a pi older than 0.99.0 prints as Mirador's pi extension turns it down. */
const OLD_PI_REFUSAL = 'Error: Failed to load extension "session-extension.js": Failed to load extension: Mirador needs pi 0.99.0 or later. Update pi with npm install -g @earendil-works/pi-coding-agent';

test.beforeAll(async () => {
  await host.start();
  mkdirSync(host.projectDir, { recursive: true });
  writeFileSync(oldPi, `#!/bin/sh\necho '${OLD_PI_REFUSAL}' >&2\nexit 1\n`, { mode: 0o755 });
});
test.afterAll(async () => {
  await host.stop();
  forgetPiAcpSessionsUnder(realpathSync(host.root));
  await host.cleanUp();
});

test("a pi that stops as it starts, as one older than Mirador needs does, says why rather than leaving the conversation opening", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const dialog = await createProfile(page, "old pi", `PI_ACP_PI_COMMAND=${oldPi}`, "", "pi");
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "old pi · pi" });
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page.locator(".chat-header:visible .status-detail")).toContainText("Mirador needs pi 0.99.0 or later. Update pi with npm install -g @earendil-works/pi-coding-agent", { timeout: 30_000 });
});
