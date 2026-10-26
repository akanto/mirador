import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, addWorkspaceFromSidebar, createProfile, pickProfileIfAsked, signIn, startConversation, workspaceCard } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost();

/** A folder as the page shows it, with home as ~: Windows keeps the temporary folders, and so the project, under home. */
const withHomeAsTilde = (folder: string) => (folder.startsWith(homedir() + sep) ? `~${folder.slice(homedir().length)}` : folder);

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("a workspace is a card: its folder under the name, new conversations at the bottom, the agent on a chip", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const card = workspaceCard(page, host.projectDir);
  await expect(card.locator(".workspace-folder")).toHaveText(withHomeAsTilde(dirname(host.projectDir)));

  const first = await startConversation(page);
  const second = await startConversation(page);
  const rows = card.locator("li");
  await expect(rows).toHaveCount(2);
  await expect(rows.last()).toHaveClass(/selected/);
  await expect(page).toHaveURL(new RegExp(`#/c/${second}$`));
  await rows.first().click();
  await expect(page).toHaveURL(new RegExp(`#/c/${first}$`));

  const chip = card.locator(".agent-chip-label");
  await expect(chip).toHaveText("Claude Code");
  const profiles = await createProfile(page, "home llama", "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await card.getByLabel("Agent").selectOption({ label: "home llama · opencode" });
  await expect(chip).toHaveText("home llama · opencode");
});

test("a workspace folds to its heading, by its chevron or its name, stays folded in this browser, and unfolds when one of its conversations opens", async ({ page }) => {
  const foldedDir = join(host.root, "foldable");
  const otherDir = join(host.root, "stays-open");
  [foldedDir, otherDir].forEach((directory) => mkdirSync(directory, { recursive: true }));
  await signIn(page, host);
  await addWorkspaceFromSidebar(page, foldedDir);
  await addWorkspaceFromSidebar(page, otherDir);
  const name = basename(foldedDir);
  const card = workspaceCard(page, foldedDir);
  await card.getByRole("button", { name: "+ New conversation" }).click();
  await expect(card.locator("li")).toHaveCount(1);
  await workspaceCard(page, otherDir).getByRole("button", { name: "+ New conversation" }).click();
  await expect(workspaceCard(page, otherDir).locator("li")).toHaveCount(1);

  await card.getByRole("button", { name: `Fold ${name}` }).click();
  await expect(card.getByRole("button", { name: `Unfold ${name}` })).toHaveAttribute("aria-expanded", "false");
  await expect(card.locator("li")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "+ New conversation" })).toHaveCount(0);
  await expect(card.locator(".workspace-name")).toBeVisible();

  await card.locator(".workspace-name").click();
  await expect(card.getByRole("button", { name: `Fold ${name}` })).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator("li")).toHaveCount(1);
  await card.locator(".workspace-name").click();
  await expect(card.locator("li")).toHaveCount(0);

  await page.reload();
  await expect(card.getByRole("button", { name: `Unfold ${name}` })).toBeVisible();
  await expect(card.locator("li")).toHaveCount(0);
  await expect(workspaceCard(page, otherDir).locator("li")).toHaveCount(1);

  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Palette/ })
    .click();
  await page.getByPlaceholder(/Go to a conversation/).fill(`New conversation in ${name}`);
  await page.keyboard.press("Enter");
  await expect(card.getByRole("button", { name: `Fold ${name}` })).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator("li")).toHaveCount(2);
});

test("a workspace added while the page reconnects to the host is added once it has", async ({ page }) => {
  await signIn(page, host);
  await host.stop();
  await expect(page.locator(".banner")).toHaveText("Connection lost, reconnecting…");
  const directory = join(host.root, "added-offline");
  mkdirSync(directory, { recursive: true });
  await page.getByRole("button", { name: "Add workspace" }).click();
  const input = page.getByLabel("Workspace directory");
  await input.fill(directory);
  await input.press("Enter");
  await pickProfileIfAsked(page, directory);
  await host.start();
  await expect(workspaceCard(page, directory)).toBeVisible({ timeout: 30_000 });
});

test("Enter takes the highlighted folder while its name is being typed, and adds a path that names a folder", async ({ page }) => {
  const parent = join(host.root, "completions");
  ["alpha-one", "alpha-two", "beta"].forEach((name) => mkdirSync(join(parent, name), { recursive: true }));
  await signIn(page, host);
  await page.getByRole("button", { name: "Add workspace" }).click();
  const input = page.getByLabel("Workspace directory");
  const highlighted = page.locator(".add-workspace .completions li.highlighted");

  await input.fill(`${parent}/alp`);
  await expect(highlighted).toHaveText(`${parent}/alpha-one/`);
  await expect(page.locator(".add-workspace .hint")).toHaveText("Enter or Tab takes the highlighted folder, Esc cancels");
  await input.press("Enter");
  await expect(input).toHaveValue(`${parent}/alpha-one/`);
  await expect(highlighted).toHaveCount(0);

  await input.fill(`${parent}/`);
  await expect(page.locator(".add-workspace .completions li")).toHaveCount(3);
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  await expect(highlighted).toHaveText(`${parent}/alpha-two/`);
  await input.press("Enter");
  await expect(input).toHaveValue(`${parent}/alpha-two/`);
  await expect(page.locator(".add-workspace .hint")).toHaveText("Enter adds, Tab completes, Esc cancels");
  await input.press("Enter");
  await pickProfileIfAsked(page, join(parent, "alpha-two"));
  await expect(workspaceCard(page, join(parent, "alpha-two"))).toBeVisible();
});
