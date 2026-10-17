import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, createProfile, sendMessage, signIn, waitForTurnToEnd } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost({ fakePrograms: true });
const appFile = join(host.projectDir, "src", "app.ts");
const outsideFile = join(host.root, "elsewhere", "notes.md");
const openedLog = join(host.root, "opened.log");

function fakeAgentAndOpeners() {
  mkdirSync(host.fakeProgramsDir, { recursive: true });
  writeFileSync(
    join(host.fakeProgramsDir, "opencode"),
    `#!/bin/sh\nFAKE_ACP_PROMPTS='${join(host.root, "prompts")}' exec bun '${join(import.meta.dirname, "fake-acp-agent.ts")}' "$@"\n`,
  );
  for (const opener of ["open", "xdg-open"]) {
    writeFileSync(join(host.fakeProgramsDir, opener), `#!/bin/sh\necho "$@" >> '${openedLog}'\n`);
  }
  for (const program of ["opencode", "open", "xdg-open"]) chmodSync(join(host.fakeProgramsDir, program), 0o755);
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
      await expect.poll(() => (existsSync(openedLog) ? readFileSync(openedLog, "utf8") : "").slice(before.length)).toContain(path);
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
