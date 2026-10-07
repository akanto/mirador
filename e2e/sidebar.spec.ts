import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, createProfile, signIn, startConversation, workspaceCard } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(4870);

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("a workspace is a card: its folder under the name, new conversations at the bottom, the agent on a chip", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const card = workspaceCard(page, host.projectDir);
  await expect(card.locator(".workspace-folder")).toHaveText(dirname(host.projectDir));

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

test("a workspace added while the page reconnects to the host is added once it has", async ({ page }) => {
  await signIn(page, host);
  await host.stop();
  await expect(page.locator(".banner")).toHaveText("Connection lost, reconnecting…");
  const directory = mkdtempSync(join(tmpdir(), "mirador-e2e-offline-"));
  await page.getByRole("button", { name: "Add workspace" }).click();
  const input = page.getByLabel("Workspace directory");
  await input.fill(directory);
  await input.press("Enter");
  await host.start();
  await expect(workspaceCard(page, directory)).toBeVisible({ timeout: 30_000 });
});

test("Enter takes the highlighted folder while its name is being typed, and adds a path that names a folder", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "mirador-e2e-complete-"));
  ["alpha-one", "alpha-two", "beta"].forEach((name) => mkdirSync(join(parent, name)));
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
  await expect(workspaceCard(page, join(parent, "alpha-two"))).toBeVisible();
});
