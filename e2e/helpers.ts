import { expect, type Locator, type Page } from "@playwright/test";
import type { TestHost } from "./test-host.ts";

/** Presses on the item and moves to just inside the top or bottom edge of the target, leaving the button down. */
export async function dragOnto(page: Page, item: Locator, target: Locator, edge: "top" | "bottom") {
  const from = (await item.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, edge === "top" ? to.y + 3 : to.y + to.height - 3, { steps: 10 });
}

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
  await expect(workspaceCard(page, directory)).toBeVisible();
}

export const workspaceCard = (page: Page, directory: string) => page.locator(".workspace", { has: page.locator(`.workspace-heading[title="${directory}"]`) });

export async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings…" }).click();
  return page.getByRole("dialog", { name: "Settings" });
}

export async function startConversation(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  await expect(page.locator(".chat-header:visible h2")).toHaveText("New conversation");
  await expect(page.locator(".chat-header:visible").getByLabel("Model", { exact: true })).toBeVisible({ timeout: 60_000 });
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

export const primaryModifier = async (page: Page) => ((await page.evaluate(() => navigator.userAgent.includes("Mac"))) ? "Meta" : "Control");

export async function sendMessage(page: Page, text: string) {
  const composer = page.locator(".composer:visible textarea");
  await expect(composer).toBeEditable();
  await expect(page.locator(".composer:visible .send")).toBeVisible({ timeout: 120_000 });
  await composer.fill(text);
  await composer.press("Enter");
}

export async function waitForTurnToEnd(page: Page) {
  await expect(page.locator(".chat-header:visible .badge")).toHaveText("idle", { timeout: 180_000 });
}

export function lastAgentMessage(page: Page) {
  return page.locator(".timeline:visible .message.agent").last();
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

export async function answerCanvasQuestion(page: Page, label: string) {
  const ask = page.locator(".ask");
  await ask.getByRole("radio", { name: label, exact: true }).check({ timeout: 120_000 });
  await ask.getByRole("button", { name: "Submit" }).click();
}

export async function openCanvasHistory(page: Page) {
  const toggle = page.locator(".history-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return page.getByRole("list", { name: "Canvas history" });
}

export async function openFromCanvasHistory(page: Page, title: string) {
  const history = await openCanvasHistory(page);
  await history.locator(".history-entry", { hasText: title }).click();
}

/** What ⌘V does with a screenshot on the clipboard: a paste event that carries the image as a file. */
export async function pasteImage(target: Locator, { width, height, color = "#5b5bd6" }: { width: number; height: number; color?: string }) {
  await target.evaluate(
    async (element, image) => {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.fillStyle = image.color;
      context.fillRect(0, 0, image.width, image.height);
      const transfer = new DataTransfer();
      transfer.items.add(new File([await canvas.convertToBlob({ type: "image/png" })], "screenshot.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    },
    { width, height, color },
  );
}

/** The match the find bar is on: its text, the entry it is in, and whether it shows in its conversation's view. */
export const currentMatch = (page: Page) =>
  page.evaluate(() => {
    const [range] = [...(CSS.highlights.get("find-current") ?? [])] as Range[];
    if (!range) return null;
    const entry = range.startContainer.parentElement!.closest(".timeline-entry")!;
    const view = entry.closest(".timeline")!.getBoundingClientRect();
    const match = range.getBoundingClientRect();
    return { text: range.toString(), entry: entry.textContent, inView: match.height > 0 && match.top >= view.top && match.bottom <= view.bottom };
  });
