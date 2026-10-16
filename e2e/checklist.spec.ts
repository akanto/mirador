import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, createProfile, sendMessage, signIn } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";

const host = new TestHost({ fakePrograms: true });
const promptsFile = join(host.root, "prompts");
const profileName = "checklisted";

/** An opencode stand-in that is an agent of its own, taking prompts and ending its turns at once. */
function fakeOpencode() {
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: promptsFile });
}

/** Everything the agent was given, in order; a prompt of several lines is written as it stands. */
const agentSaw = () => readFileSync(promptsFile, "utf8");

test.beforeAll(async () => {
  fakeOpencode();
  writeFileSync(promptsFile, "");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const status = (page: Page) => page.locator(".chat-header:visible .badge");
const toggle = (page: Page) => page.locator(".checklist-toggle:visible");
const canvasTitle = (page: Page) => page.locator(".canvas-header:visible .canvas-title");
const checklistItem = (page: Page, text: string) => page.locator(".checklist:visible .checklist-item", { hasText: text });
const checkbox = (page: Page, text: string) => checklistItem(page, text).getByRole("checkbox");

/** The stub agent offers no model to pick, so this is `startConversation` without that wait. */
async function startConversationWithoutModel(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

async function sendAndWait(page: Page, text: string) {
  await sendMessage(page, text);
  await expect(status(page)).toHaveText("idle", { timeout: 60_000 });
}

const release = {
  title: "Release 0.4.2",
  sections: [
    { title: "Build", items: [{ id: "tests", text: "Run the tests" }, { id: "build", text: "Build the app", detail: "Signed and **notarized**" }] },
    { title: "Ship", items: [{ id: "publish", text: "Publish the release" }, { id: "announce", text: "Post the announcement", owner: "user" }] },
  ],
};

test("the agent publishes a checklist and ticks it as it goes, your ticks reach it, its own plan is pinned, and all of it stays across a reload", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  const conversationId = await startConversationWithoutModel(page);
  await sendAndWait(page, "Start");

  await test.step("publishing opens the Checklist tab: sections, details and whose each item is, outside the canvas history", async () => {
    const published = await callCanvasTool(host, conversationId, "checklist", release);
    expect(published).toContain("4 items, 0 of 4 done");
    expect(published).toContain("naming them by id: tests, build, publish, announce");
    await expect(toggle(page)).toHaveText("Checklist 0/4");
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(canvasTitle(page)).toHaveText("Release 0.4.2");
    await expect(page.locator(".checklist:visible .checklist-section h4")).toHaveText(["Build 0/2", "Ship 0/2"]);
    const lastBuildItem = await checklistItem(page, "Build the app").boundingBox();
    const shipHeading = await page.locator(".checklist:visible .checklist-section h4", { hasText: "Ship" }).boundingBox();
    expect(shipHeading!.y - (lastBuildItem!.y + lastBuildItem!.height), "a section stands apart from the one before it").toBeGreaterThanOrEqual(12);
    await expect(checklistItem(page, "Build the app").locator(".checklist-detail strong")).toHaveText("notarized");
    await expect(checklistItem(page, "Post the announcement").locator(".checklist-owner")).toHaveText("you");
    await expect(checklistItem(page, "Run the tests").locator(".checklist-owner")).toHaveCount(0);
    await expect(page.locator(".canvas-header:visible .history-toggle")).toHaveText("History (0)");
  });

  await test.step("the agent ticks an item: the count goes up and the item flashes", async () => {
    const result = await callCanvasTool(host, conversationId, "update_checklist", { items: [{ id: "tests", done: true }] });
    expect(result).toBe('On the checklist, updated "tests"; 1 of 4 done.');
    await expect(toggle(page)).toHaveText("Checklist 1/4");
    await expect(checkbox(page, "Run the tests")).toBeChecked();
    await expect(checklistItem(page, "Run the tests")).toHaveClass(/agent-edited/);
  });

  await test.step("an id the checklist does not have changes nothing, and the agent hears why", async () => {
    const result = await callCanvasTool(host, conversationId, "update_checklist", { items: [{ id: "nope", done: true }] });
    expect(result).toContain("The checklist was not changed");
    expect(result).toContain('"nope" is not an item of this checklist (tests, build, publish, announce).');
    await expect(toggle(page)).toHaveText("Checklist 1/4");
  });

  await test.step("a new page closes the tab; a tick while it is closed flashes the tab, and the item once it opens", async () => {
    await callCanvasTool(host, conversationId, "show", { title: "Diagram", html: "<p>A diagram</p>" });
    await expect(canvasTitle(page)).toHaveText("Diagram");
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    await callCanvasTool(host, conversationId, "update_checklist", { items: [{ id: "build", done: true }] });
    await expect(toggle(page)).toHaveText("Checklist 2/4");
    await expect(toggle(page)).toHaveClass(/agent-edited/);
    await toggle(page).click();
    await expect(canvasTitle(page)).toHaveText("Release 0.4.2");
    await expect(checklistItem(page, "Build the app")).toHaveClass(/agent-edited/);
    expect(await checklistItem(page, "Run the tests").getAttribute("class")).not.toContain("agent-edited");
  });

  await test.step("the close button by the checklist's title goes back to the page under it, and the tab opens again", async () => {
    await page.locator(".canvas-header:visible").getByRole("button", { name: "Close the checklist" }).click();
    await expect(canvasTitle(page)).toHaveText("Diagram");
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".checklist:visible")).toHaveCount(0);
    await toggle(page).click();
    await expect(canvasTitle(page)).toHaveText("Release 0.4.2");
  });

  await test.step("your tick reaches the agent with your next message, which the chat shows without the note", async () => {
    await checkbox(page, "Publish the release").click();
    await expect(checkbox(page, "Publish the release")).toBeChecked();
    await expect(toggle(page)).toHaveText("Checklist 3/4");
    await sendAndWait(page, "Carry on");
    expect(agentSaw()).toContain('On your checklist "Release 0.4.2", the user ticked "publish" (Publish the release).\n\nCarry on\n');
    await expect(page.locator(".timeline:visible .message.user").last()).not.toContainText("On your checklist");
    await sendAndWait(page, "And again");
    expect(agentSaw().endsWith("Carry on\nAnd again\n")).toBe(true);
  });

  await test.step("a tick made since the agent last heard comes back in update_checklist's result, not with the next message", async () => {
    await checkbox(page, "Run the tests").click();
    await expect(checkbox(page, "Run the tests")).not.toBeChecked();
    const result = await callCanvasTool(host, conversationId, "update_checklist", { items: [{ id: "announce", text: "Announce it" }] });
    expect(result).toBe('On the checklist, updated "announce"; 2 of 4 done. Since you last heard, the user unticked "tests" (Run the tests).');
    await expect(checklistItem(page, "Announce it")).toBeVisible();
  });

  await test.step("the agent's own plan is pinned under the checklist", async () => {
    await sendAndWait(page, `PLAN ${JSON.stringify([{ content: "Read the code", done: true }, { content: "Write the tool", done: false }, { content: "Test it", done: false }])}`);
    const plan = page.locator(".checklist:visible .checklist-plan");
    await expect(plan.locator("h4")).toHaveText("Agent's plan 1/3");
    await expect(plan.getByRole("checkbox")).toHaveCount(3);
    await expect(plan.getByRole("checkbox").first()).toBeChecked();
    await expect(plan.getByRole("checkbox").first()).toBeDisabled();
    await expect(plan.locator(".checklist-item", { hasText: "Write the tool" }).locator(".checklist-owner")).toHaveText("in progress");
  });

  await test.step("after a reload the checklist, your ticks and the plan are all still there, and nothing flashes for what changed before it", async () => {
    await page.reload();
    await expect(canvasTitle(page)).toHaveText("Diagram");
    await expect(toggle(page)).toHaveText("Checklist 2/4");
    expect(await toggle(page).getAttribute("class"), "the agent's change from before the reload does not flash again").not.toContain("agent-edited");
    await toggle(page).click();
    await expect(checkbox(page, "Publish the release")).toBeChecked();
    expect(await checklistItem(page, "Announce it").getAttribute("class")).not.toContain("agent-edited");
    await expect(checkbox(page, "Run the tests")).not.toBeChecked();
    await expect(page.locator(".checklist:visible .checklist-plan h4")).toHaveText("Agent's plan 1/3");
  });

  await test.step("publishing again replaces the checklist: ticks stay with their ids, and the agent hears what it had not", async () => {
    await checkbox(page, "Announce it").click();
    await expect(checkbox(page, "Announce it")).toBeChecked();
    await toggle(page).click();
    const replacement = { title: "Release 0.4.2, the rest", sections: [{ items: [{ id: "build", text: "Build the app" }, { id: "announce", text: "Announce it" }, { id: "watch", text: "Watch the update" }] }] };
    const result = await callCanvasTool(host, conversationId, "checklist", replacement);
    expect(result).toContain('Done as on the checklist it replaces: "build" (Build the app), "announce" (Announce it).');
    expect(result).toContain('On the checklist it replaces ("Release 0.4.2"), the user ticked "announce" (Announce it).');
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(canvasTitle(page)).toHaveText("Release 0.4.2, the rest");
    await expect(toggle(page)).toHaveText("Checklist 2/3");
    await expect(page.locator(".checklist:visible .checklist-list .checklist-item")).toHaveCount(3);
    await sendAndWait(page, "Last one");
    expect(agentSaw().endsWith("\nLast one\n")).toBe(true);
    expect(agentSaw()).not.toContain("On your checklist \"Release 0.4.2\", the user ticked \"announce\"");
  });
});
