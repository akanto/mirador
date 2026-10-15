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
