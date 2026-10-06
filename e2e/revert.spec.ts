import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, createProfile, primaryModifier, sendMessage, signIn } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5272, { fakePrograms: true });
const promptsFile = join(host.root, "prompts");
const profileName = "rewindable";
const readme = join(host.projectDir, "README.md");
const made = join(host.projectDir, "made.txt");
let headAtStart = "";

/** An opencode stand-in that is an agent of its own, taking prompts and ending its turns at once. */
function fakeOpencode() {
  mkdirSync(host.fakeProgramsDir, { recursive: true });
  const program = join(host.fakeProgramsDir, "opencode");
  writeFileSync(program, `#!/bin/sh\nFAKE_ACP_PROMPTS='${promptsFile}' exec bun '${join(import.meta.dirname, "fake-acp-agent.ts")}' "$@"\n`);
  chmodSync(program, 0o755);
}

/** Everything the agent was given, in order; a prompt of several lines is written as it stands. */
const agentSaw = () => readFileSync(promptsFile, "utf8");

const noteAboutAddAFile =
  'The user put this workspace\'s files back to how they were before the turn that began with "Add a file"';

const git = (...args: string[]) =>
  execFileSync("git", ["-C", host.projectDir, "-c", "user.name=e2e", "-c", "user.email=e2e@localhost", ...args], { encoding: "utf8" }).trim();

test.beforeAll(async () => {
  fakeOpencode();
  writeFileSync(promptsFile, "");
  await host.start();
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-qm", "the project as it was");
  headAtStart = await git("rev-parse", "HEAD");
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const status = (page: Page) => page.locator(".chat-header:visible .badge");
const userMessage = (page: Page) => page.locator(".timeline:visible .message.user").last();
const undoFiles = (page: Page) => page.locator(".timeline:visible .undo-files").last();

/** The stub agent offers no model to pick, so this is `startConversation` without that wait. */
async function startConversationWithoutModel(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

test("a turn's files go back to how they were, the agent hears about it, and your git history is left alone", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  await startConversationWithoutModel(page);
  await sendMessage(page, "Add a file");
  await expect(status(page)).toHaveText("idle", { timeout: 60_000 });

  await test.step("the message of a turn Mirador kept files for offers to undo them", async () => {
    await expect(undoFiles(page)).toBeHidden();
    await userMessage(page).hover();
    await expect(undoFiles(page)).toBeVisible();
    await expect(undoFiles(page)).toHaveText("Undo files");
  });

  await test.step("the dialog says what the undo would change, and putting the files back does it", async () => {
    writeFileSync(readme, "changed by the turn\n");
    writeFileSync(made, "made by the turn\n");
    await userMessage(page).hover();
    await undoFiles(page).click();
    const dialog = page.getByRole("dialog", { name: "Undo the files of a turn" });
    await expect(dialog).toContainText("1 file put back as they were and 1 file created since deleted");
    await dialog.getByRole("button", { name: "Put the files back" }).click();
    await expect(dialog).toHaveCount(0);
    expect(readFileSync(readme, "utf8")).toBe("# e2e project\n");
    expect(() => readFileSync(made, "utf8")).toThrow();
  });

  await test.step("the conversation keeps the turn and notes the undo", async () => {
    await expect(page.locator(".timeline:visible")).toContainText("Files put back to how they were before the turn of “Add a file”");
    await expect(userMessage(page)).toHaveText("Add a file");
  });

  await test.step("the agent is told, ahead of the next message", async () => {
    await sendMessage(page, "Start again");
    await expect.poll(agentSaw).toContain(noteAboutAddAFile);
    expect(agentSaw().indexOf(noteAboutAddAFile)).toBeLessThan(agentSaw().lastIndexOf("Start again"));
  });

  await test.step("the palette undoes a turn by name, the same way the message does", async () => {
    writeFileSync(made, "made again\n");
    const primary = await primaryModifier(page);
    await page.keyboard.press(`${primary}+KeyK`);
    const palette = page.getByLabel("Search conversations and actions");
    await palette.fill("undo the files");
    await palette.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Undo the files of a turn" });
    await expect(dialog).toContainText("Start again");
    await dialog.getByRole("button", { name: "Put the files back" }).click();
    await expect(dialog).toHaveCount(0);
    expect(() => readFileSync(made, "utf8")).toThrow();
  });

  await test.step("the user's own history and index are untouched", async () => {
    expect(await git("rev-parse", "HEAD")).toBe(headAtStart);
    expect(await git("log", "--format=%s")).toBe("the project as it was");
    expect(await git("status", "--porcelain")).toBe("");
  });
});
