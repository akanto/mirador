import { expect, type Page } from "@playwright/test";
import type { TestHost } from "./test-host.ts";

export async function callCanvasTool(host: TestHost, conversationId: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${host.origin}/mcp/${conversationId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${host.mcpToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.text();
  const payload = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  const message = JSON.parse(payload ?? body);
  return message.result.content[0].text as string;
}

export async function signIn(page: Page, host: TestHost) {
  await page.goto(host.authUrl);
  await expect(page.getByText("No conversation selected")).toBeVisible();
}

export async function addWorkspace(page: Page, directory: string) {
  await page.getByRole("button", { name: "+ Add a project directory" }).click();
  const input = page.getByLabel("Workspace directory");
  await input.fill(directory);
  await input.press("Enter");
  await expect(page.locator(".workspace-path", { hasText: directory })).toBeVisible();
}

export async function startConversation(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  await expect(page.locator(".chat-header h2")).toHaveText("New conversation");
  await expect(page.getByLabel("Model", { exact: true })).toBeVisible({ timeout: 60_000 });
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

export async function sendMessage(page: Page, text: string) {
  const composer = page.locator(".composer textarea");
  await expect(composer).toBeEditable();
  await expect(page.locator(".composer .send")).toBeVisible({ timeout: 120_000 });
  await composer.fill(text);
  await composer.press("Enter");
}

export async function waitForTurnToEnd(page: Page) {
  await expect(page.locator(".chat-header .badge")).toHaveText("idle", { timeout: 180_000 });
}

export function lastAgentMessage(page: Page) {
  return page.locator(".message.agent").last();
}

export async function openProfiles(page: Page) {
  await page.getByRole("button", { name: "Profiles…" }).click();
  return page.getByRole("dialog", { name: "Profiles" });
}

export async function createProfile(page: Page, name: string, environment: string, prelaunch = "", agent = "Claude Code") {
  const dialog = await openProfiles(page);
  await dialog.locator(".profile-list li", { hasText: "+ New profile" }).click();
  await dialog.getByLabel("Profile name").fill(name);
  await dialog.getByLabel("Profile agent").selectOption({ label: agent });
  await dialog.getByLabel("Environment", { exact: true }).fill(environment);
  await dialog.getByLabel("Pre-launch command").fill(prelaunch);
  await dialog.getByRole("button", { name: "Create profile" }).click();
  await expect(dialog.locator(".profile-list li.selected")).toHaveText(`${name}${agent}`);
  return dialog;
}
