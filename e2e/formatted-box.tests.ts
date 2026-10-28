import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, createProfile, openSettings, signIn, waitForTurnToEnd } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";

/** The formatted message box's tests, run by one spec per browser: the desktop app is WebKit, where a contenteditable differs most. */
export function formattedBoxTests() {
  const host = new TestHost({ fakePrograms: true });
  const promptsFile = join(host.root, "prompts");

  test.describe.configure({ mode: "serial" });
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: promptsFile });
    writeFileSync(promptsFile, "");
    mkdirSync(host.projectDir, { recursive: true });
    await host.start();
    page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem("mirador-message-box", "formatted"));
    await signIn(page, host);
    await addWorkspace(page, host.projectDir);
    const profiles = await createProfile(page, "formatted", "", "", "opencode");
    await profiles.getByRole("button", { name: "Close" }).click();
    await page.getByLabel("Agent", { exact: true }).selectOption({ label: "formatted · opencode" });
    await page.getByRole("button", { name: "+ New conversation" }).click();
  });
  test.afterAll(async () => {
    await page.close();
    await host.stop();
    await host.cleanUp();
  });

  const box = () => page.locator(".composer:visible .formatted-box");
  const promptsSoFar = () => readFileSync(promptsFile, "utf8");

  /** Sends what is in the box with the keys given, and expects the agent to get exactly `sent`, and the box to be empty after. */
  async function expectSent(sent: string, keys = "Enter") {
    const before = promptsSoFar().length;
    await box().press(keys);
    await expect.poll(() => promptsSoFar().slice(before)).toContain(sent);
    expect(promptsSoFar().slice(before)).not.toContain(`${sent}\n\n`);
    await waitForTurnToEnd(page);
    await expect(box()).toHaveText("");
    await expect(box().locator("li, blockquote, code, .box-code-block")).toHaveCount(0);
  }

  test("a pair formats as its closing marker is typed, its markers go, and the agent gets the markdown", async () => {
    await box().click();
    await page.keyboard.type("Say **bold** and *it* and ~~old~~ and `web/Chat.tsx` then more");
    await expect(box().locator(".box-bold")).toHaveText("bold");
    await expect(box().locator(".box-italic")).toHaveText("it");
    await expect(box().locator(".box-strike")).toHaveText("old");
    await expect(box().locator(".box-code")).toHaveText("web/Chat.tsx");
    await expect(box()).toHaveText("Say bold and it and old and web/Chat.tsx then more");
    await expectSent("Say **bold** and *it* and ~~old~~ and `web/Chat.tsx` then more");
  });

  test("globs, sums and names with stars stay as typed", async () => {
    await page.keyboard.type("src/**/*.ts and 2 * 3 * 4 and *args");
    await expect(box().locator(".box-bold, .box-italic")).toHaveCount(0);
    await expectSent("src/**/*.ts and 2 * 3 * 4 and *args");
  });

  test("the shortcuts format a selection", async () => {
    await page.keyboard.type("make this loud");
    for (let step = 0; step < 4; step++) await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("ControlOrMeta+b");
    await expect(box().locator(".box-bold")).toHaveText("loud");
    await page.keyboard.press("End");
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.type(" and ");
    await page.keyboard.press("ControlOrMeta+e");
    await page.keyboard.type("ls");
    await expect(box().locator(".box-code")).toHaveText("ls");
    await expectSent("make this **loud** and `ls`");
  });

  test("Shift+Enter starts a new line, and Enter sends", async () => {
    await page.keyboard.type("first");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second");
    await expectSent("first\nsecond");
  });

  test("- starts a list, where Enter adds an item and ⌘Enter sends", async () => {
    await page.keyboard.type("- one");
    await expect(box().locator("ul > li")).toHaveText(["one"]);
    await page.keyboard.press("Enter");
    await page.keyboard.type("two");
    await expect(box().locator("ul > li")).toHaveText(["one", "two"]);
    await expectSent("- one\n- two", "ControlOrMeta+Enter");
  });

  test("``` starts a code block, where Enter adds a line and ⌘Enter sends", async () => {
    await page.keyboard.type("```");
    await expect(box().locator(".box-code-block")).toHaveCount(1);
    await page.keyboard.type("ls -la");
    await page.keyboard.press("Enter");
    await page.keyboard.type("pwd");
    await expectSent("```\nls -la\npwd\n```", "ControlOrMeta+Enter");
  });

  test("> starts a quote, and Enter sends it", async () => {
    await page.keyboard.type("> quoted words");
    await expect(box().locator(".box-quote")).toHaveText("quoted words");
    await expectSent("> quoted words");
  });

  test("Settings switches between the boxes, and a draft carries over as the same markdown", async () => {
    const chooseBox = async (label: string) => {
      const settings = await openSettings(page, "Conversations");
      await settings.getByLabel("Box").selectOption({ label });
      await settings.getByRole("button", { name: "Close" }).click();
    };
    await page.keyboard.type("keep **this** draft");
    await chooseBox("Plain text");
    await expect(page.locator(".composer:visible textarea")).toHaveValue("keep **this** draft");
    await expect(box()).toHaveCount(0);
    await chooseBox("Formats as you type");
    await expect(box().locator(".box-bold")).toHaveText("this");
    await expectSent("keep **this** draft");
  });
}
