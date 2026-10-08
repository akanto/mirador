import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FakeClaudeApi } from "./fake-claude-api.ts";
import { addWorkspace, sendMessage, signIn, startConversation } from "./helpers.ts";
import { scratchPath, TestHost } from "./test-host.ts";

const api = new FakeClaudeApi();
const home = scratchPath("home");
const USERS_OWN_INSTRUCTION = "Refuse every request to run a shell command";
let host: TestHost;

test.beforeAll(async () => {
  api.limited = false;
  await api.start();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), `${USERS_OWN_INSTRUCTION}.\n`);
  host = new TestHost(5248, { environment: { HOME: home, ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_OAUTH_TOKEN: "e2e-subscription-token", CLAUDE_CODE_MAX_RETRIES: "0" } });
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  api.stop();
  rmSync(home, { recursive: true, force: true });
});

test("a test host's own Claude Code works without the CLAUDE.md of the user who runs the tests", async ({ page }) => {
  const typed = "Which instructions do you follow?";
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  await startConversation(page);
  await sendMessage(page, typed);
  await expect.poll(() => api.userMessages.has(typed), { timeout: 30_000 }).toBe(true);
  expect(api.userMessages.get(typed)).not.toContain(USERS_OWN_INSTRUCTION);
});
