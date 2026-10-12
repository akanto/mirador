import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addWorkspace, callCanvasTool, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5180, { fakePrograms: true });

function git(...args: string[]) {
  return execFileSync("git", ["-C", host.projectDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

const bigFile = Array.from({ length: 300 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n") + "\n";

test.beforeAll(async () => {
  mkdirSync(host.projectDir, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(host.projectDir, "small.ts"), "export const small = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(host.projectDir, "big.ts"), bigFile);
  git("add", ".");
  git("commit", "-q", "-m", "add big.ts");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const longRange = { severity: "nit", checked: "plausible", at: "big.ts:1-300", title: "Whole file", body: "Was all of this meant to change?" };
const shortRange = { severity: "nit", checked: "plausible", at: "big.ts:10-12", title: "Three lines", body: "Why these three?" };

test("a finding anchored past the excerpt cap keeps both ends of its range and marks what was left out", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const result = await callCanvasTool(host, conversationId, "review", {
    title: "Big file",
    repository: host.projectDir,
    base: "main",
    verdict: "Approve.",
    summary: "Adds big.ts.",
    flow: [],
    findings: [longRange, shortRange],
  });
  expect(result).toContain("2 findings");

  const view = page.locator(".review");
  await view.getByRole("tab", { name: /Findings/ }).click();
  const wholeFile = view.locator(".finding", { hasText: "Whole file" });
  const block = wholeFile.locator(".code-block");

  await expect(block.locator(".code-row.elided")).toContainText("… 141 lines not shown …");
  await expect(block.locator(".code-row.elided .line-number")).toHaveCount(0);
  await expect(block.getByRole("button", { name: "Line 1", exact: true })).toBeVisible();
  await expect(block.getByRole("button", { name: "Line 300", exact: true })).toBeVisible();
  await expect(block.getByRole("button", { name: "Line 80", exact: true })).toHaveCount(0);

  const threeLines = view.locator(".finding", { hasText: "Three lines" }).locator(".code-block");
  await expect(threeLines.locator(".code-row.elided")).toHaveCount(0);
  await expect(threeLines.getByRole("button", { name: "Line 4", exact: true })).toBeVisible();
  await expect(threeLines.getByRole("button", { name: "Line 18", exact: true }).first()).toBeVisible();
});
