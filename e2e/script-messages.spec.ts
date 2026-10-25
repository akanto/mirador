import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { Conversation } from "../shared/model.ts";
import { addWorkspace, lastAgentMessage, sendMessage, signIn, startConversation, waitForTurnToEnd } from "./helpers.ts";
import { spawnProgram, TestHost } from "./test-host.ts";

const host = new TestHost();
const mirador = resolve("bin/mirador");
/** What a script outside Git Bash runs: Windows runs no script without an extension, so there it is mirador.cmd. */
const miradorForScripts = process.platform === "win32" ? `${mirador}.cmd` : mirador;

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

function runMiradorMessage(args: string[]) {
  return new Promise<{ exitCode: number | null; stderr: string }>((settle) => {
    const environment = { ...process.env, MIRADOR_URL: host.origin, MIRADOR_SCRIPT_TOKEN: host.scriptToken };
    const script = spawnProgram(miradorForScripts, ["message", ...args], { env: environment, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    script.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    script.on("close", (exitCode) => settle({ exitCode, stderr }));
  });
}

const postMessage = (sessionId: string, body: string) =>
  fetch(`${host.origin}/sessions/${sessionId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${host.scriptToken}` }, body });

function recordAgentSessions(page: Page) {
  const sessionByConversation = new Map<string, string>();
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      const conversation = (JSON.parse(String(payload)) as { conversation?: Conversation }).conversation;
      if (conversation?.acpSessionId) sessionByConversation.set(conversation.id, conversation.acpSessionId);
    }),
  );
  return sessionByConversation;
}

const messagesFromScripts = (page: Page) =>
  page.locator(".timeline-entry", { has: page.locator(".author", { hasText: "From a script" }) }).locator(".message.user");

test("a script the agent starts, or anything with the agent's session, messages the conversation as the user would", async ({ page }) => {
  const sessionByConversation = recordAgentSessions(page);
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const yolo = page.getByLabel("YOLO", { exact: true });
  await yolo.click();
  await expect(yolo).toBeChecked();

  await test.step("a command the agent runs reaches its own conversation, and the agent reads the message", async () => {
    await sendMessage(
      page,
      `Run the shell command \`${mirador} message "The build finished with 3 warnings."\` once with your Bash tool. A message about the build will reach you; don't run the command again, reply with just the number of warnings, as a digit.`,
    );
    await expect(messagesFromScripts(page)).toHaveText(["The build finished with 3 warnings."], { timeout: 120_000 });
    await waitForTurnToEnd(page);
    await expect(lastAgentMessage(page)).toContainText("3");
  });

  const sessionId = sessionByConversation.get(conversationId)!;
  expect(sessionId).toBeTruthy();

  await test.step("while the agent is idle, a message for its session starts the next turn", async () => {
    expect(await runMiradorMessage(["--session", sessionId, "Reply with just the word PONG."])).toEqual({ exitCode: 0, stderr: "" });
    await expect(messagesFromScripts(page)).toHaveCount(2, { timeout: 30_000 });
    await expect(messagesFromScripts(page).last()).toHaveText("Reply with just the word PONG.");
    await waitForTurnToEnd(page);
    await expect(lastAgentMessage(page)).toContainText("PONG");
  });

  await test.step("an unknown session, an empty message or one too long is refused with the reason", async () => {
    const unknown = await runMiradorMessage(["--session", "not-a-session", "hello"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("No Mirador conversation runs this agent session.");
    expect((await postMessage(sessionId, "  \n")).status).toBe(400);
    expect((await postMessage(sessionId, "x".repeat(64 * 1024 + 1))).status).toBe(413);
    await expect(messagesFromScripts(page)).toHaveCount(2);
  });

  await test.step("a script's turn whose reply stops at a step it announced is nudged on, a couple of times in a row at most", async () => {
    const nudges = messagesFromScripts(page).filter({ hasText: "your reply ended announcing a next step" });
    expect(await runMiradorMessage(["--session", sessionId, "Reply with exactly this line, and nothing else: Next I check the logs:"])).toEqual({ exitCode: 0, stderr: "" });
    await expect(nudges.first()).toBeVisible({ timeout: 120_000 });
    // A nudge starts its turn as the stopped one ends, so idle can flash between them: settle before counting.
    await waitForTurnToEnd(page);
    await page.waitForTimeout(5_000);
    await waitForTurnToEnd(page);
    expect(await nudges.count()).toBeLessThanOrEqual(2);
  });
});
