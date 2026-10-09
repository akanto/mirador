import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, createProfile, sendMessage, signIn, waitForTurnToEnd } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5340, { fakePrograms: true });
const appFile = join(host.projectDir, "src", "app.ts");
const generatedFile = join(host.projectDir, "src", "generated.txt");
const outsideFile = join(host.root, "elsewhere", "notes.md");
const editNow = join(host.root, "edit-now");
const finishNow = join(host.root, "finish-now");
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
const withLine15 = (text: string) => numbered(30).replace("line 15\n", `${text}\n`);

/** An opencode that is the scripted agent, writing the files a prompt names. */
function fakeOpencode() {
  mkdirSync(host.fakeProgramsDir, { recursive: true });
  writeFileSync(
    join(host.fakeProgramsDir, "opencode"),
    `#!/bin/sh\nFAKE_ACP_PROMPTS='${join(host.root, "prompts")}' exec bun '${join(import.meta.dirname, "fake-acp-agent.ts")}' "$@"\n`,
  );
  chmodSync(join(host.fakeProgramsDir, "opencode"), 0o755);
}

const git = (...args: string[]) => execFileSync("git", ["-C", host.projectDir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fakeOpencode();
  mkdirSync(join(host.projectDir, "src"), { recursive: true });
  writeFileSync(appFile, numbered(30));
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const changes = (page: Page) => page.locator(".canvas-panel .changes");
const fileRow = (page: Page, path: string) => changes(page).locator(".changed-file").filter({ has: page.locator(".changed-path", { hasText: new RegExp(`^${path}$`) }) });
const section = (page: Page, name: string) => changes(page).getByRole("region", { name, exact: true });
const writeFiles = (page: Page, steps: Record<string, string>[]) => sendMessage(page, `WRITE ${JSON.stringify(steps)}`);

async function startConversation(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

let conversationId: string;

test("the empty canvas lists the files this turn changed as the agent works, with its own edits marked and files outside the project apart", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, "changes", "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "changes · opencode" });
  conversationId = await startConversation(page);
  await expect(changes(page)).toContainText("Files the agent changes in this conversation show here.");
  await expect(changes(page).getByRole("button", { name: "This turn" })).toHaveAttribute("aria-pressed", "true");

  await writeFiles(page, [
    { waitFor: editNow },
    { edit: appFile, content: withLine15("line fifteen") },
    { waitFor: finishNow },
    { shell: generatedFile, content: "made by a script\n" },
    { edit: outsideFile, content: "outside the project\n" },
  ]);

  await test.step("a finished edit shows while the turn still runs", async () => {
    await expect(changes(page)).toContainText("No file changed in this turn.");
    writeFileSync(editNow, "");
    await expect(fileRow(page, "src/app.ts")).toContainText("+1 −1");
    await expect(fileRow(page, "src/app.ts").locator(".by-agent")).toHaveText("● agent");
    await expect(page.locator(".chat-header:visible .badge")).not.toHaveText("idle");
  });

  writeFileSync(finishNow, "");
  await waitForTurnToEnd(page);

  await expect(section(page, "Project").locator(".changed-path")).toHaveText(["src/app.ts", "src/generated.txt"]);
  await expect(fileRow(page, "src/generated.txt").locator(".change-status")).toHaveText("A");
  await expect(fileRow(page, "src/generated.txt").locator(".by-agent")).toHaveCount(0);
  await expect(section(page, "Outside the project").locator(".changed-path")).toHaveText([outsideFile]);
  await expect(fileRow(page, outsideFile).locator(".by-agent")).toHaveText("● agent");
});

test("clicking a file opens its line changes under its row, with the file's line numbers, unified or split, and Open in IDEA", async ({ page }) => {
  await signIn(page, host);
  await page.goto(`${host.origin}/#/c/${conversationId}`);
  await fileRow(page, "src/app.ts").click();

  const diff = changes(page).locator(".changes-diff");
  const appItem = changes(page).locator("li", { has: page.locator(".changed-path", { hasText: /^src\/app\.ts$/ }) });
  await expect(appItem.locator(".changes-diff")).toBeVisible();
  const [diffBox, nextRowBox] = await Promise.all([diff.boundingBox(), fileRow(page, "src/generated.txt").boundingBox()]);
  expect(diffBox!.y + diffBox!.height, "the next file's row comes after the open file's line changes").toBeLessThanOrEqual(nextRowBox!.y);
  await expect(diff.locator(".edited-file h3")).toHaveText("src/app.ts");
  await expect(diff.locator(".code-row.removed .line-number")).toHaveText("15");
  await expect(diff.locator(".code-row.added .line-number")).toHaveText("15");
  await expect(diff.locator(".code-row.added")).toContainText("line fifteen");
  await expect(diff.getByRole("button", { name: "Open in IDEA" })).toBeVisible();

  await diff.getByRole("button", { name: "Split" }).click();
  await expect(diff.locator(".split-side.removed .line-number")).toHaveText("15");
  await diff.getByRole("button", { name: "Unified" }).click();

  await test.step("a file outside the project shows the agent's own edit", async () => {
    await fileRow(page, outsideFile).click();
    await expect(diff.locator(".edited-file h3")).toHaveText(outsideFile);
    await expect(diff).toContainText("The agent's own edits to this file");
    await expect(diff.locator(".code-row.added")).toContainText("outside the project");
  });

  await test.step("clicking the selected file again closes its line changes", async () => {
    await fileRow(page, outsideFile).click();
    await expect(diff).toHaveCount(0);
  });
});

test("a new turn starts with an empty list, while Uncommitted keeps git status against HEAD", async ({ page }) => {
  await signIn(page, host);
  await page.goto(`${host.origin}/#/c/${conversationId}`);
  await expect(fileRow(page, "src/app.ts")).toBeVisible();
  await sendMessage(page, "nothing to change");
  await waitForTurnToEnd(page);
  await expect(changes(page)).toContainText("No file changed in this turn.");

  await changes(page).getByRole("button", { name: "Uncommitted" }).click();
  await expect(section(page, "Project").locator(".changed-path")).toHaveText(["src/app.ts", "src/generated.txt"]);
  await expect(fileRow(page, "src/app.ts").locator(".by-agent")).toHaveText("● agent");
  await expect(section(page, "Outside the project").locator(".changed-path")).toHaveText([outsideFile]);

  await test.step("a change made by hand shows after Refresh", async () => {
    writeFileSync(join(host.projectDir, "by-hand.txt"), "typed\n");
    await changes(page).getByRole("button", { name: "Refresh" }).click();
    await expect(fileRow(page, "by-hand.txt")).toBeVisible();
    await expect(fileRow(page, "by-hand.txt").locator(".by-agent")).toHaveCount(0);
  });

  await test.step("the scope stays chosen after a reload", async () => {
    await page.reload();
    await expect(changes(page).getByRole("button", { name: "Uncommitted" })).toHaveAttribute("aria-pressed", "true");
    await changes(page).getByRole("button", { name: "This turn" }).click();
  });
});

test("Changes opens over a page, and a new page takes the canvas back", async ({ page }) => {
  await signIn(page, host);
  await page.goto(`${host.origin}/#/c/${conversationId}`);
  const canvas = page.locator(".canvas-panel");
  const changesButton = canvas.locator(".canvas-header").getByRole("button", { name: "Changes", exact: true });
  await expect(changesButton).toBeDisabled();

  await callCanvasTool(host, conversationId, "show", { title: "First page", html: "<p>first</p>" });
  await expect(canvas.locator(".canvas-title")).toHaveText("First page");
  await expect(changes(page)).toHaveCount(0);

  await changesButton.click();
  await expect(canvas.locator(".canvas-title")).toHaveText("Changes");
  await expect(section(page, "Project").locator(".changed-path")).toHaveText(["by-hand.txt"]);
  await expect(canvas.locator("iframe")).toHaveCount(0);

  await changesButton.click();
  await expect(canvas.locator(".canvas-title")).toHaveText("First page");

  await changesButton.click();
  await callCanvasTool(host, conversationId, "show", { title: "Second page", html: "<p>second</p>" });
  await expect(canvas.locator(".canvas-title")).toHaveText("Second page");
  await expect(changes(page)).toHaveCount(0);

  await test.step("an edit the agent waits to make takes the canvas from Changes too", async () => {
    await changesButton.click();
    await expect(changes(page)).toBeVisible();
    await sendMessage(page, `EDIT ${JSON.stringify([{ title: "Edit src/app.ts", path: appFile, oldText: "line 16\n", newText: "line sixteen\n" }])}`);
    await expect(canvas.locator(".canvas-title")).toHaveText("Edit src/app.ts");
    await expect(changes(page)).toHaveCount(0);
    await canvas.locator(".edit-approval").getByRole("button", { name: "Reject" }).click();
    await waitForTurnToEnd(page);
  });
});

test("a conversation's canvas comes back as it was left: Changes still open, or the page still shown", async ({ page }) => {
  await signIn(page, host);
  await page.goto(`${host.origin}/#/c/${conversationId}`);
  const canvas = page.locator(".canvas-panel");
  const changesButton = canvas.locator(".canvas-header").getByRole("button", { name: "Changes", exact: true });
  await callCanvasTool(host, conversationId, "show", { title: "Third page", html: "<p>third</p>" });
  await expect(canvas.locator(".canvas-title")).toHaveText("Third page");

  await changesButton.click();
  await expect(canvas.locator(".canvas-title")).toHaveText("Changes");
  const otherId = await startConversation(page);
  await page.goto(`${host.origin}/#/c/${conversationId}`);
  await expect(canvas.locator(".canvas-title")).toHaveText("Changes");

  await changesButton.click();
  await expect(canvas.locator(".canvas-title")).toHaveText("Third page");
  await page.goto(`${host.origin}/#/c/${otherId}`);
  await page.goto(`${host.origin}/#/c/${conversationId}`);
  await expect(canvas.locator(".canvas-title")).toHaveText("Third page");

  await callCanvasTool(host, conversationId, "show", { title: "Fourth page", html: "<p>fourth</p>" });
  await expect(canvas.locator(".canvas-title")).toHaveText("Fourth page");
});

test("Changes shows the files it listed last as soon as it opens again, and still updates them when they change", async ({ page }) => {
  let heldLists: string[] | null = null;
  let sendHeldLists = () => {};
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    const host = socket.connectToServer();
    socket.onMessage((message) => {
      if (heldLists && /"type":"changes\.(list|diff)"/.test(String(message))) heldLists.push(String(message));
      else host.send(message);
    });
    sendHeldLists = () => {
      heldLists?.forEach((message) => host.send(message));
      heldLists = null;
    };
  });
  await signIn(page, host);
  await page.goto(`${host.origin}/#/c/${conversationId}`);
  const canvas = page.locator(".canvas-panel");
  const changesButton = canvas.locator(".canvas-header").getByRole("button", { name: "Changes", exact: true });
  await changesButton.click();
  await changes(page).getByRole("button", { name: "Uncommitted" }).click();
  await expect(section(page, "Project").locator(".changed-path")).toHaveText(["by-hand.txt", "src/app.ts", "src/generated.txt"]);
  await fileRow(page, "src/app.ts").click();
  await expect(changes(page).locator(".changes-diff .code-row.added")).toContainText("line fifteen");

  await changesButton.click();
  await expect(changes(page)).toHaveCount(0);
  heldLists = [];
  await changesButton.click();
  await expect.poll(() => heldLists?.length, "the list and the open file's changes are asked for again").toBe(2);
  await expect(section(page, "Project").locator(".changed-path"), "the list from before, while the host has not answered").toHaveText([
    "by-hand.txt",
    "src/app.ts",
    "src/generated.txt",
  ]);
  await expect(changes(page).locator(".changes-diff .code-row.added"), "with the file that was open still open").toContainText("line fifteen");
  await expect(changes(page)).not.toContainText("Loading…");

  writeFileSync(join(host.projectDir, "later.txt"), "later\n");
  sendHeldLists();
  await changes(page).getByRole("button", { name: "Refresh" }).click();
  await expect(section(page, "Project").locator(".changed-path")).toHaveText(["by-hand.txt", "later.txt", "src/app.ts", "src/generated.txt"]);

  await test.step("when the host comes back after a restart, an empty canvas lists the files again", async () => {
    await startConversation(page);
    await expect(fileRow(page, "later.txt")).toBeVisible();
    writeFileSync(join(host.projectDir, "while-away.txt"), "away\n");
    await host.restart();
    await expect(fileRow(page, "while-away.txt")).toBeVisible({ timeout: 60_000 });
  });
  await changes(page).getByRole("button", { name: "This turn" }).click();
});
