import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, createProfile, sendMessage, signIn } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5410, { fakePrograms: true });
const promptsFile = join(host.root, "prompts");

/** An opencode that is an agent of its own, holding a WRITE turn until the file it waits for exists. */
function fakeOpencode() {
  mkdirSync(host.fakeProgramsDir, { recursive: true });
  writeFileSync(
    join(host.fakeProgramsDir, "opencode"),
    `#!/bin/sh\nFAKE_ACP_PROMPTS='${promptsFile}' exec bun '${join(import.meta.dirname, "fake-acp-agent.ts")}' "$@"\n`,
  );
  chmodSync(join(host.fakeProgramsDir, "opencode"), 0o755);
}

const prompts = () => readFileSync(promptsFile, "utf8").split("\n");
const status = (page: Page) => page.locator(".chat-header:visible .badge");
const heldTurn = (release: string, ended?: string) =>
  `WRITE ${JSON.stringify([{ waitFor: release }, ...(ended ? [{ shell: ended, content: "" }] : [])])}`;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fakeOpencode();
  writeFileSync(promptsFile, "");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

async function useProfile(page: Page, name: string, environment: string) {
  const profiles = await createProfile(page, name, environment, "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${name} · opencode` });
}

/** The stub agent offers no model to pick, so this is `startConversation` without that wait. */
async function startConversationWithoutModel(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  await expect(status(page)).toHaveText("idle", { timeout: 30_000 });
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

/** Listens the way the desktop app does and returns the waiting counts the host has announced so far. */
async function listenForWaitingCounts() {
  const signedIn = await fetch(host.authUrl, { redirect: "manual" });
  const token = signedIn.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  const desktopApp = spawn("bun", ["e2e/desktop-notifier.ts", host.origin, token], { stdio: ["ignore", "pipe", "inherit"] });
  const counts: number[] = [];
  createInterface({ input: desktopApp.stdout! }).on("line", (line) => {
    const count = line.match(/^waiting (\d+)$/)?.[1];
    if (count !== undefined) counts.push(Number(count));
  });
  return { counts, stop: () => desktopApp.kill() };
}

test("a conversation deleted while its turn runs leaves nothing waiting for you once the turn ends", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  await useProfile(page, "fake", "");
  const waiting = await listenForWaitingCounts();
  try {
    await startConversationWithoutModel(page);
    const release = join(host.root, "release-deleted-turn");
    const ended = join(host.root, "deleted-turn-ended");
    await sendMessage(page, heldTurn(release, ended));
    await expect(status(page)).toHaveText("running", { timeout: 30_000 });
    const deleteButton = page.locator(".workspace li.selected").getByRole("button", { name: "Delete conversation" });
    await deleteButton.click();
    await deleteButton.click();

    const other = await startConversationWithoutModel(page);
    writeFileSync(release, "");
    await expect.poll(() => existsSync(ended)).toBe(true);
    await page.waitForTimeout(500);
    void callCanvasTool(host, other, "ask", { question: "Still one?", options: [{ label: "Yes" }, { label: "No" }] }).catch(() => {});
    await expect(page.getByRole("heading", { name: "Still one?" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => waiting.counts.at(-1)).toBe(1);
    await page.waitForTimeout(500);
    expect(Math.max(...waiting.counts)).toBe(1);
  } finally {
    waiting.stop();
  }
});
