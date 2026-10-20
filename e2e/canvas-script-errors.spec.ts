import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, createProfile, sendMessage, signIn } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";

const host = new TestHost({ fakePrograms: true });
const promptsFile = join(host.root, "prompts");
const profileName = "page-maker";
const HIDDEN_THROW = "A script on the page threw an error; this browser hides its message.";

test.beforeAll(async () => {
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: promptsFile });
  writeFileSync(promptsFile, "");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const status = (page: Page) => page.locator(".chat-header:visible .badge");
const pageErrors = (page: Page) => page.locator(".canvas-frame.show .frame-errors li");

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

async function startWithAgent(page: Page) {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  const conversationId = await startConversationWithoutModel(page);
  await sendAndWait(page, "Start");
  return conversationId;
}

test("a page's script errors reach the agent, one the browser hides says so, and none comes twice", async ({ page }) => {
  const conversationId = await startWithAgent(page);
  const assetsOrigin = `http://127.0.0.1:${host.port + 1}`;
  const html = `<p>Charts</p>
<script>draw("c1", [[[1, 2]]]], 200);</script>
<script src="${assetsOrigin}/three/addons/controls/OrbitControls.js"></script>`;

  const result = await callCanvasTool(host, conversationId, "show", { title: "Charts", html });

  const reported = result.split("\n").slice(1);
  expect(result).toContain("but the page reported errors:");
  expect(reported).toHaveLength(2);
  expect(reported[0]).toMatch(/^- Uncaught SyntaxError: .*missing \) after argument list/);
  expect(reported[1]).toBe(`- ${HIDDEN_THROW}`);
  await expect(pageErrors(page)).toHaveText([/SyntaxError: .*missing \) after argument list/, HIDDEN_THROW]);
});
