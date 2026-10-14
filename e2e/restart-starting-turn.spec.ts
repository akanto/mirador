import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, createProfile, primaryModifier, sendMessage, signIn, waitForTurnToEnd } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost({ fakePrograms: true });
const promptsFile = join(host.root, "prompts");
const PRELAUNCH_SECONDS = 5;

/** An opencode that is an agent of its own, which answers every prompt at once. */
function fakeOpencode() {
  mkdirSync(host.fakeProgramsDir, { recursive: true });
  writeFileSync(join(host.fakeProgramsDir, "opencode"), `#!/bin/sh\nFAKE_ACP_PROMPTS='${promptsFile}' exec bun '${join(import.meta.dirname, "fake-acp-agent.ts")}' "$@"\n`);
  chmodSync(join(host.fakeProgramsDir, "opencode"), 0o755);
}

const prompts = () =>
  readFileSync(promptsFile, "utf8")
    .split("\n")
    .filter((text) => text !== "");

const hostStarts = () => host.log.match(/Mirador is running/g)?.length ?? 0;

test.beforeAll(async () => {
  fakeOpencode();
  writeFileSync(promptsFile, "");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("Cmd+Shift+R while a turn's agent is still starting restarts the host, and messages go out after it", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, "slow start", "", `sleep ${PRELAUNCH_SECONDS}`, "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "slow start · opencode" });
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  await sendMessage(page, "first");
  await expect.poll(prompts, { timeout: 30_000 }).toContain("first");
  await waitForTurnToEnd(page);

  await test.step("after a restart from outside, the next turn waits for the agent's pre-launch command", async () => {
    await host.restart();
    await sendMessage(page, "second");
    await expect(page.locator(".chat-header:visible .badge")).toHaveText("starting");
  });

  await test.step("Cmd+Shift+R restarts the host then, rather than leave it holding every message", async () => {
    const startsBefore = hostStarts();
    await page.keyboard.press(`${await primaryModifier(page)}+Shift+R`);
    await expect.poll(hostStarts, { timeout: 60_000 }).toBe(startsBefore + 1);
    await sendMessage(page, "third");
    await expect.poll(prompts, { timeout: 60_000 }).toContain("third");
    await expect(page.locator(".queue:visible .queued-text")).toHaveCount(0);
  });
});
