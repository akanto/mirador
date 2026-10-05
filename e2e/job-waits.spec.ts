import { spawn, type ChildProcess } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, createProfile, sendMessage, signIn, startConversation, waitForTurnToEnd } from "./helpers.ts";
import { ScriptedModel, scriptedOpencodeEnvironment } from "./scripted-model.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5222);
const model = new ScriptedModel();
const PROFILE = "scripted opencode";
const jobs: ChildProcess[] = [];

test.beforeAll(async () => {
  await model.start();
  await host.start();
});
test.afterAll(async () => {
  jobs.forEach((job) => job.kill());
  await host.stop();
  await host.cleanUp();
  model.stop();
});

/** A job the agent might leave running, like a build started with nohup. */
function startJob() {
  const job = spawn("sleep", ["300"], { stdio: "ignore" });
  jobs.push(job);
  return job;
}

/** opencode gives the commands it runs no session id, so an agent of it names its session for mirador when-done; Claude Code's commands inherit it. */
function watchSessionId(page: Page) {
  let sessionId: string | null = null;
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      sessionId = message.type === "conversation.upserted" ? (message.conversation.acpSessionId ?? sessionId) : sessionId;
    }),
  );
  return () => sessionId;
}

test("the agent has the host wait for a job it left running, then resume the agent, or only tell you, also after a restart", async ({ page }) => {
  test.setTimeout(180_000);
  const sessionId = watchSessionId(page);
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const dialog = await createProfile(page, PROFILE, scriptedOpencodeEnvironment(model, host.root), "", "opencode");
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${PROFILE} · opencode` });
  await startConversation(page);
  const yolo = page.getByLabel("YOLO", { exact: true });
  await yolo.click();
  await expect(yolo).toBeChecked();
  await expect.poll(sessionId).not.toBeNull();

  const waits = page.getByRole("region", { name: "Jobs waited for" });
  const notices = page.locator(".notice-line");
  const fromScript = page.locator(".timeline-entry", { has: page.locator(".author", { hasText: "From a script" }) }).locator(".message.user");
  const toolResult = async (answer: string) => {
    await expect(page.locator(".timeline .message.agent", { hasText: `Tool result: ${answer}` })).toHaveCount(1);
    await waitForTurnToEnd(page);
  };
  const whenDone = async (job: ChildProcess, message: string, { resume = true, answer = `Mirador waits for process ${job.pid}` } = {}) => {
    await sendMessage(page, `CALL when_done ${JSON.stringify({ pid: job.pid, message, resume })}`);
    await toolResult(answer);
  };

  await test.step("the agent's when_done call sets up the wait, which shows above the message box", async () => {
    const job = startJob();
    await whenDone(job, "build-finished check the output");
    const offered = model.requests.flatMap(({ tools }) => tools ?? []).find(({ function: { name } }) => name.endsWith("when_done"));
    expect(offered?.function.description, "the tool tells the agent when to call it").toContain("don't poll it with sleep");
    await expect(waits.locator("li")).toHaveCount(1);
    await expect(waits).toContainText(`Waiting for process ${job.pid} to end`);
    await expect(waits).toContainText("Then the agent gets: build-finished check the output");
    await expect(waits.locator(".job-wait-message"), "a message shown whole opens no further").not.toHaveAttribute("role", "button");

    await test.step("when the job ends, the agent gets the message as your next one and carries on", async () => {
      job.kill();
      await expect(notices.filter({ hasText: `Process ${job.pid} ended` })).toHaveCount(1);
      await expect(fromScript.filter({ hasText: "build-finished check the output" })).toHaveCount(1);
      await expect(waits).toHaveCount(0);
      await waitForTurnToEnd(page);
      await expect.poll(() => model.userMessagesInContext().join("\n")).toContain("build-finished check the output");
    });
  });

  await test.step("without resuming the agent, only you are told: the agent gets nothing", async () => {
    const job = startJob();
    await whenDone(job, "look-at-the-results", { resume: false });
    await expect(waits).toContainText("Then you are told: look-at-the-results");
    const messagesBefore = await page.locator(".timeline .message.user").count();
    job.kill();
    await expect(notices.filter({ hasText: `Process ${job.pid} ended: look-at-the-results` })).toHaveCount(1);
    await expect(waits).toHaveCount(0);
    await expect(page.locator(".timeline .message.user")).toHaveCount(messagesBefore);
  });

  await test.step("a long message shows its first lines, without a hint; a click shows all of it, and another its first lines again", async () => {
    const job = startJob();
    const longMessage = `dl-glm GLM-5.3-Flash UD-IQ4_XS download to /mnt/backup/${"a-long-folder-name/".repeat(12)}model.gguf finished, check its checksum and start llama-server with it on port 8080, then run the benchmark`;
    await whenDone(job, longMessage);
    const status = waits.locator(".job-wait-status");
    const message = waits.locator(".job-wait-message");
    expect(await status.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const heightOf = (element: Element) => element.getBoundingClientRect().height;
    const clampedHeight = await message.evaluate(heightOf);
    expect(clampedHeight).toBeGreaterThan(2.5 * (await status.evaluate(heightOf)));
    const showsAllOfIt = () => message.evaluate((element) => element.scrollHeight <= element.clientHeight);
    expect(await showsAllOfIt()).toBe(false);
    await message.hover();
    await expect(message).toHaveCSS("cursor", "pointer");
    await page.waitForTimeout(1_000);
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    await message.click();
    await expect(message).toHaveAttribute("aria-expanded", "true");
    expect(await showsAllOfIt()).toBe(true);
    expect(await message.evaluate(heightOf)).toBeGreaterThan(clampedHeight);
    await expect(message).toContainText(`Then the agent gets: ${longMessage}`);

    await message.click();
    await expect(message).toHaveAttribute("aria-expanded", "false");
    expect(await message.evaluate(heightOf)).toBe(clampedHeight);
    await waits.getByRole("button", { name: "Stop waiting" }).click();
    await expect(waits).toHaveCount(0);
    job.kill();
  });

  await test.step("Stop waiting drops the wait: the job's end goes unnoticed", async () => {
    const job = startJob();
    await whenDone(job, "never-sent");
    await waits.getByRole("button", { name: "Stop waiting" }).click();
    await expect(waits).toHaveCount(0);
    await expect(notices.filter({ hasText: `Stopped waiting for process ${job.pid}` })).toHaveCount(1);
    job.kill();
    await page.waitForTimeout(2_500);
    await expect(notices.filter({ hasText: `Process ${job.pid} ended` })).toHaveCount(0);
    await expect(fromScript.filter({ hasText: "never-sent" })).toHaveCount(0);
  });

  await test.step("a job that does not run is refused, so a mistyped pid does not end its wait at once", async () => {
    const job = startJob();
    job.kill();
    await new Promise((resolve) => job.once("exit", resolve));
    await whenDone(job, "too-late", { answer: `There is no running process ${job.pid}.` });
    await expect(waits).toHaveCount(0);
  });

  await test.step("mirador when-done does the same from a command, given the agent's session", async () => {
    const job = startJob();
    await sendMessage(page, `RUN mirador when-done --session ${sessionId()} --pid ${job.pid} from-a-command`);
    await toolResult(`Mirador waits for process ${job.pid}`);
    await expect(waits).toContainText("Then the agent gets: from-a-command");
    await waits.getByRole("button", { name: "Stop waiting" }).click();
    await expect(waits).toHaveCount(0);
    job.kill();
  });

  await test.step("the wait goes on through a host restart, and a job that ended meanwhile resumes the agent", async () => {
    const job = startJob();
    await whenDone(job, "ended-while-host-was-down");
    await host.stop();
    job.kill();
    await host.start();
    await page.reload();
    await expect(notices.filter({ hasText: `Process ${job.pid} ended` })).toHaveCount(1);
    await expect(fromScript.filter({ hasText: "ended-while-host-was-down" })).toHaveCount(1);
    await waitForTurnToEnd(page);
    await expect.poll(() => model.userMessagesInContext().join("\n")).toContain("ended-while-host-was-down");
  });
});
