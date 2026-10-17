import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, createProfile, sendMessage, signIn, waitForTurnToEnd } from "./helpers.ts";
import { TestHost, writeBunProgram, writeCompiledBunProgram } from "./test-host.ts";

const host = new TestHost({ fakePrograms: true });
const appFile = join(host.projectDir, "src", "app.ts");
const outsideFile = join(host.root, "elsewhere", "notes.md");
const openedLog = join(host.root, "opened.log");

function fakeAgentAndOpeners() {
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: join(host.root, "prompts") });
  for (const opener of ["open", "xdg-open"]) {
    writeFileSync(join(host.fakeProgramsDir, opener), `#!/bin/sh\necho "$@" >> '${openedLog}'\n`);
    chmodSync(join(host.fakeProgramsDir, opener), 0o755);
  }
  // Windows opens a file by running Invoke-Item on powershell.exe, so a stand-in powershell notes the opening there.
  if (process.platform === "win32") writeCompiledBunProgram(host.fakeProgramsDir, "powershell", join(import.meta.dirname, "fake-powershell-opener.ts"), { MIRADOR_OPENED_LOG: openedLog });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  mkdirSync(join(host.projectDir, "src"), { recursive: true });
  mkdirSync(join(host.root, "elsewhere"), { recursive: true });
  fakeAgentAndOpeners();
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const toolCardFor = (page: import("@playwright/test").Page, path: string) =>
  page.locator("details.tool").filter({ has: page.locator(".locations button", { hasText: path }) });

test("a file the agent wrote is a link in its tool card, and clicking it opens the file with the system's default program", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, "open-files", "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "open-files · opencode" });
  await page.getByRole("button", { name: "+ New conversation" }).click();

  await sendMessage(page, `WRITE ${JSON.stringify([{ edit: appFile, content: "export {};\n" }, { edit: outsideFile, content: "notes\n" }])}`);
  await waitForTurnToEnd(page);

  for (const path of [appFile, outsideFile]) {
    await test.step(`clicking the link for ${path} opens it`, async () => {
      const card = toolCardFor(page, path);
      await card.locator("summary").click();
      await card.locator(".locations button", { hasText: path }).click();
      await expect.poll(() => (existsSync(openedLog) ? readFileSync(openedLog, "utf8") : "")).toContain(path);
    });
  }
});

test("a file path the agent writes in backticks in its reply is a link that opens the file", async ({ page }) => {
  await signIn(page, host);
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "open-files · opencode" });
  await page.getByRole("button", { name: "+ New conversation" }).click();

  await sendMessage(page, `SAY Look at \`${appFile}\` and \`src/app.ts\`, then \`not a file\`.`);
  await waitForTurnToEnd(page);

  for (const path of [appFile, "src/app.ts"]) {
    await test.step(`the path ${path} opens`, async () => {
      const before = existsSync(openedLog) ? readFileSync(openedLog, "utf8") : "";
      await page.locator(".markdown").getByRole("button", { name: path, exact: true }).click();
      // The host logs the path as it opens it: absolute, with this system's separators.
      await expect.poll(() => (existsSync(openedLog) ? readFileSync(openedLog, "utf8") : "").slice(before.length)).toContain(resolve(host.projectDir, path));
    });
  }
  await expect(page.locator(".markdown button.file-link", { hasText: "not a file" })).toHaveCount(0);
});


test("a link to a program says Mirador does not run it, and opens nothing", async ({ page }) => {
  const program = join(host.projectDir, "tools", "run.jar");
  mkdirSync(join(host.projectDir, "tools"), { recursive: true });
  writeFileSync(program, "");
  await signIn(page, host);
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "open-files · opencode" });
  await page.getByRole("button", { name: "+ New conversation" }).click();

  await sendMessage(page, "SAY Run `tools/run.jar` to build it.");
  await waitForTurnToEnd(page);

  const openedBefore = existsSync(openedLog) ? readFileSync(openedLog, "utf8") : "";
  await page.locator(".markdown").getByRole("button", { name: "tools/run.jar", exact: true }).click();
  await expect(page.locator(".notices .notice", { hasText: "tools/run.jar would run as a program, so Mirador does not open it." })).toBeVisible();
  expect(existsSync(openedLog) ? readFileSync(openedLog, "utf8") : "").toBe(openedBefore);
});
