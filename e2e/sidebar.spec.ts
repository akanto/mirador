import { dirname } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, signIn, startConversation, workspaceCard } from "./helpers.ts";
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
  await card.getByLabel("Agent").selectOption({ label: "opencode" });
  await expect(chip).toHaveText("opencode");
});
