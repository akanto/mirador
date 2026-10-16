import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, createProfile, lastAgentMessage, sendMessage, signIn, waitForTurnToEnd } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";

const host = new TestHost({ fakePrograms: true });

/** An opencode that is the scripted agent, streaming the words a prompt asks for. */
const fakeOpencode = () =>
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: join(host.root, "prompts") });

test.beforeAll(async () => {
  fakeOpencode();
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const WORD_COUNT = 300;
const words = Array.from({ length: WORD_COUNT }, (_, index) => `word${index + 1}`);

/** Counts the batches of DOM changes that touch an agent message: one for each time its text is re-rendered. */
async function countAgentMessageUpdates(page: Page) {
  await page.evaluate(() => {
    const counter = window as unknown as { agentMessageUpdates: number };
    const agentMessageOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest(".message.agent");
    const touchesAgentMessage = (node: Node) => agentMessageOf(node) != null || (node instanceof Element && node.querySelector(".message.agent") != null);
    counter.agentMessageUpdates = 0;
    new MutationObserver((records) => {
      if (records.some(({ target, addedNodes }) => [target, ...addedNodes].some(touchesAgentMessage))) counter.agentMessageUpdates++;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return () => page.evaluate(() => (window as unknown as { agentMessageUpdates: number }).agentMessageUpdates);
}

test("a reply that streams in word by word shows all of its text once the turn ends, re-rendered a few times a second rather than per word", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, "stream", "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "stream · opencode" });
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page.locator(".chat-header:visible h2")).toHaveText("New conversation");
  const agentMessageUpdates = await countAgentMessageUpdates(page);
  await sendMessage(page, `STREAM ${WORD_COUNT}`);
  await waitForTurnToEnd(page);
  await expect(lastAgentMessage(page)).toContainText(words.join(" "));
  expect(await agentMessageUpdates()).toBeLessThan(100);
});
