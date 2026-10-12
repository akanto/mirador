import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, lastAgentMessage, openSettings, pasteImage, sendMessage, signIn, startConversation, waitForTurnToEnd } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(4730);
const QUEUED = "Also, which colour fills [Image #1] - answer with the colour's name.";
const AFTER_TURN = "Reply with just the word LATER.";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

/** The user messages and turn ends the page hears about, in the order they come. */
function eventsInOrderOn(page: Page) {
  const events: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      const event = JSON.parse(String(payload)).event?.event;
      if (event?.type === "turn-end") events.push("turn-end");
      if (event?.type === "user-message") events.push(event.text);
    }),
  );
  return events;
}

test("a message sent with Enter while Claude Code runs a tool joins the turn once the tool finishes, with its image; one sent the other way waits for the turn to end", async ({ page }) => {
  const eventsInOrder = eventsInOrderOn(page);
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  await startConversation(page);
  const yolo = page.getByLabel("YOLO", { exact: true });
  await yolo.click();
  await expect(yolo).toBeChecked();
  await sendMessage(page, "Run the shell command `sleep 30; echo slept` with your Bash tool, then reply with what it printed.");
  await expect(page.locator(".timeline").locator(".tool-pending, .tool-in_progress").first()).toBeVisible({ timeout: 120_000 });

  const composer = page.locator(".composer textarea");
  await composer.fill("Also, which colour fills ");
  await pasteImage(composer, { width: 64, height: 64, color: "#e11d1d" });
  await page.keyboard.type("- answer with the colour's name.");
  await expect(composer).toHaveValue(QUEUED);
  await expect(page.locator(".pasted-images img")).toHaveJSProperty("naturalWidth", 64);
  await composer.press("Enter");
  await expect(page.locator(".queue .queued-text")).toHaveText([QUEUED]);
  await expect(page.locator(".queued-delivery")).toHaveText(["joins the turn"]);

  await test.step("with Enter set to wait for the turn, Enter and the buttons swap roles", async () => {
    const settings = await openSettings(page, "Conversations");
    await settings.getByLabel("Enter").selectOption({ label: "Sends the message after the turn ends" });
    await settings.getByRole("button", { name: "Close" }).click();
    await composer.fill(AFTER_TURN);
    await expect(page.locator(".composer .queue-message")).toHaveText(["After turn", "Steer"]);
    const [message, buttons] = await Promise.all([composer.boundingBox(), page.locator(".composer-actions").boundingBox()]);
    expect(buttons!.y, "the buttons sit under the message").toBeGreaterThanOrEqual(message!.y + message!.height);
    expect(message!.width, "and leave the message the box's full width").toBeCloseTo(buttons!.width, 0);
    await expect(composer).toHaveAttribute("placeholder", /Enter sends your message after its turn/);
    await composer.press("Enter");
    const afterTurnTag = page.locator(".queued", { hasText: AFTER_TURN }).locator(".queued-delivery");
    await expect(afterTurnTag).toHaveText("after the turn");
    await afterTurnTag.click();
    await expect(afterTurnTag).toHaveText("joins the turn");
    await afterTurnTag.click();
    await expect(afterTurnTag).toHaveText("after the turn");
  });

  const userMessages = page.locator(".message.user");
  await expect(userMessages.filter({ hasText: QUEUED })).toHaveCount(1, { timeout: 60_000 });
  await expect(userMessages.last()).toHaveText(AFTER_TURN, { timeout: 120_000 });
  await expect(page.locator(".queue")).toHaveCount(0);
  await waitForTurnToEnd(page);
  await expect(page.locator(".message.agent", { hasText: /red/i })).not.toHaveCount(0);
  await expect(lastAgentMessage(page)).toContainText("LATER");
  await expect(userMessages.filter({ hasText: QUEUED }).locator(".message-images img")).toHaveJSProperty("naturalWidth", 64);
  expect(eventsInOrder).toEqual([expect.stringContaining("sleep 30"), QUEUED, "turn-end", AFTER_TURN, "turn-end"]);
});

test("a message sent while Claude Code writes, with no tool running, joins the turn at once, and so does a waiting one switched to join it", async ({ page }) => {
  const eventsInOrder = eventsInOrderOn(page);
  await signIn(page, host);
  await page.goto(host.origin);
  await startConversation(page);
  const composer = page.locator(".composer textarea");
  const story = (keeper: string) => `Write a 1500-word story about a lighthouse keeper called ${keeper}, as plain text in your reply. Use no tools.`;
  const stopWith = (word: string) => `Stop the story there and reply with only the word ${word}.`;
  const agentMessages = page.locator(".timeline .message.agent");
  const turnsEnded = () => eventsInOrder.filter((event) => event === "turn-end").length;
  const keepersOfSilentStories: string[] = [];
  const startStory = async (keeper: string) => {
    const [messagesBefore, turnsEndedBefore] = [await agentMessages.count(), turnsEnded()];
    await sendMessage(page, story(keeper));
    await expect.poll(async () => (await agentMessages.count()) > messagesBefore || turnsEnded() > turnsEndedBefore, { timeout: 120_000 }).toBe(true);
    return (await agentMessages.count()) > messagesBefore;
  };
  /** The model now and then writes the whole story in its thinking, which Claude Code hides, and ends the turn with nothing to show; that story is asked for once more. */
  const tellStory = async (keeper: string) => {
    if (await startStory(keeper)) return;
    keepersOfSilentStories.push(keeper);
    await waitForTurnToEnd(page);
    expect(await startStory(keeper), "the agent is writing").toBe(true);
  };
  const silentStoryOf = (keeper: string) => (keepersOfSilentStories.includes(keeper) ? [story(keeper), "turn-end"] : []);

  await test.step("sent with Enter", async () => {
    await tellStory("Ada");
    await composer.fill(stopWith("PINEAPPLE"));
    await composer.press("Enter");
    await waitForTurnToEnd(page);
    await expect(lastAgentMessage(page)).toContainText("PINEAPPLE");
  });

  await test.step("waiting for the turn to end, then switched to join it", async () => {
    await tellStory("Bo");
    await composer.fill(stopWith("MANGO"));
    await page.locator(".composer .queue-message", { hasText: "After turn" }).click();
    const delivery = page.locator(".queued", { hasText: stopWith("MANGO") }).locator(".queued-delivery");
    await expect(delivery).toHaveText("after the turn");
    await delivery.click();
    await waitForTurnToEnd(page);
    await expect(lastAgentMessage(page)).toContainText("MANGO");
  });

  expect(eventsInOrder).toEqual([...silentStoryOf("Ada"), story("Ada"), stopWith("PINEAPPLE"), "turn-end", ...silentStoryOf("Bo"), story("Bo"), stopWith("MANGO"), "turn-end"]);
});
