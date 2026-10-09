import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { signIn, waitForTurnToEnd, workspaceCard } from "../../e2e/helpers.ts";
import type { Demo, DemoConversation } from "../../e2e/seed-demo.ts";
import { TestHost } from "../../e2e/test-host.ts";
import { Cursor } from "./cursor.ts";
import { createWorld, worldIn } from "./demo-world.ts";
import { Director } from "./director.ts";
import { ClipRecorder } from "./recorder.ts";
import { LAYOUT_CHOICE, prompts, scripts } from "./scenes.ts";
import { expect, test } from "./studio.ts";
import { typeLikeAPerson } from "./typing.ts";

/**
 * Films the trailer's clips from a throwaway Mirador running the real Claude Code against the director, never against
 * anyone's account or conversations. Each scene is one clip in public/clips, with the moments and boxes the edit keys
 * its camera and captions to. Run from the repository: bunx playwright test -c video/playwright.config.ts
 */
const root = join(realpathSync(tmpdir()), `mirador-video-${crypto.randomUUID().slice(0, 8)}`);
const world = worldIn(root);
const { shopApi, mobileApp, storefront, infra } = world.projects;
const host = new TestHost(5900, {
  shell: "/bin/zsh",
  environment: { HOME: world.home, ZDOTDIR: world.home, GIT_PAGER: "cat", MIRADOR_TEST_MODEL: "default", MIRADOR_TEST_EFFORT: "default" },
});
const director = new Director(scripts({ projects: world.projects, assetsOrigin: `http://127.0.0.1:${host.port + 1}` }));
const clips = join(import.meta.dirname, "..", "public", "clips");
const theme = process.env.MIRADOR_VIDEO_THEME ?? "dark";

test.beforeAll(async () => {
  createWorld(world);
  await director.start();
  mkdirSync(host.dataDir, { recursive: true });
  execFileSync("bun", [join(import.meta.dirname, "seed-profile.ts"), join(host.dataDir, "state.sqlite"), director.environment]);
  await host.start();
});

test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  director.stop();
  rmSync(root, { recursive: true, force: true });
});

async function addWorkspace(page: Page, directory: string) {
  await page.getByRole("button", { name: "Add workspace" }).click();
  const input = page.getByLabel("Workspace directory");
  await input.fill(directory);
  await input.press("Enter");
  await expect(workspaceCard(page, directory)).toBeVisible();
}

async function newConversationIn(page: Page, directory: string) {
  const previousUrl = page.url();
  await workspaceCard(page, directory).getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  await expect(page.locator(".chat-header:visible").getByLabel("Model", { exact: true })).toBeVisible({ timeout: 60_000 });
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

async function openConversation(page: Page, conversationId: string) {
  await page.evaluate((id) => {
    location.hash = `/c/${id}`;
  }, conversationId);
  await expect(page.locator(".composer:visible textarea")).toBeEditable();
}

/** Starts a turn without filming it, for conversations that work in the background of a scene. */
async function sendOffCamera(page: Page, conversationId: string, text: string) {
  await openConversation(page, conversationId);
  const composer = page.locator(".composer:visible textarea");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.locator(".timeline:visible .message.user").filter({ hasText: text })).toBeVisible();
}

/** Types into the composer on camera and sends it. */
async function sendOnCamera(page: Page, cursor: Cursor, recorder: ClipRecorder, text: string) {
  const composer = page.locator(".composer:visible textarea");
  await cursor.click(composer);
  recorder.mark("typing");
  await typeLikeAPerson(page, text);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  recorder.mark("sent");
}

const sidebarItem = (page: Page, directory: string, title: string) => workspaceCard(page, directory).locator("li", { hasText: title });
const canvasPane = (page: Page) => page.locator('[data-pane="canvas"]');

const update = (update: Record<string, unknown>) => ({ type: "acp", update });
const userSays = (text: string) => ({ type: "user-message", text });
const agentSays = (text: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const turnEnd = { type: "turn-end", stopReason: "end_turn" };
const ranCommand = (toolCallId: string, command: string, description: string, output: string) =>
  update({ sessionUpdate: "tool_call", toolCallId, title: command, kind: "execute", status: "completed", rawInput: { command, description }, content: [{ type: "content", content: { type: "text", text: output } }] });

test("the trailer's clips", async ({ page }) => {
  mkdirSync(clips, { recursive: true });
  await page.addInitScript((chosen) => window.top === window && localStorage.setItem("mirador-theme", chosen), theme);
  const cursor = new Cursor(page, { x: 980, y: 620 });
  await cursor.install();
  await signIn(page, host);
  for (const directory of [infra, storefront, mobileApp, shopApi]) await addWorkspace(page, directory);

  const ids = {
    flakyLogin: await newConversationIn(page, shopApi),
    reviewRetries: await newConversationIn(page, shopApi),
    stopDoubleCharge: await newConversationIn(page, shopApi),
    explainCheckout: await newConversationIn(page, shopApi),
    coldStart: await newConversationIn(page, mobileApp),
    settingsLayout: await newConversationIn(page, mobileApp),
    translate: await newConversationIn(page, storefront),
    postgres: await newConversationIn(page, infra),
  };
  const conversation = (id: string, title: string, minutesAgo: number, events: unknown[], unseenTurnEnd?: DemoConversation["unseenTurnEnd"]): DemoConversation => ({ id, title, minutesAgo, events, unseenTurnEnd });
  const demo: Demo = {
    workspaceColors: { [shopApi]: "sky", [mobileApp]: "mint", [storefront]: "lavender", [infra]: "peach" },
    sidebar: [{ group: "Shop", workspaces: [shopApi, mobileApp, storefront] }, infra],
    conversations: [
      conversation(
        ids.flakyLogin,
        "Fix the flaky login test",
        25,
        [
          userSays("The login e2e fails about one run in ten. Find out why and fix it."),
          ranCommand("toolu_runs", "bunx playwright test e2e/login.spec.ts --repeat-each 20", "Run the login spec twenty times", "  20 passed (1.4m)"),
          agentSays("Fixed: the test pressed Enter before the sign-in form was ready. It now waits for the form, and twenty runs in a row pass."),
          turnEnd,
        ],
        "finished",
      ),
      conversation(ids.reviewRetries, "Review: retry card payments", 3, []),
      conversation(ids.stopDoubleCharge, "Stop the double charge", 2, []),
      conversation(ids.explainCheckout, "Explain the checkout flow", 1, []),
      conversation(ids.coldStart, "Speed up the cold start", 30, [userSays("Profile the cold start on a mid-range phone and cut it below a second."), agentSays("Starting a trace on the emulator…"), { type: "turn-end", stopReason: "refusal" }], "error"),
      conversation(ids.settingsLayout, "Pick a settings layout", 2, []),
      conversation(ids.translate, "Translate the checkout pages", 2, []),
      conversation(ids.postgres, "Plan the Postgres 18 upgrade", 90, [userSays("Plan the upgrade to Postgres 18 with no downtime."), agentSays("Logical replication to a new 18 cluster, then a switch-over in the next maintenance window."), turnEnd]),
    ],
  };
  await host.stop();
  execFileSync("bun", [join(import.meta.dirname, "..", "..", "e2e", "seed-demo.ts"), join(host.dataDir, "state.sqlite"), JSON.stringify(demo)]);
  await host.start();
  await page.reload();
  await cursor.restore();
  const recorder = new ClipRecorder(page, clips);
  const film = async (name: string, scene: () => Promise<void>) => {
    await recorder.start(name);
    await scene();
    const info = await recorder.stop();
    console.log(`${name}: ${info.seconds.toFixed(1)} s, ${info.frames} frames, gaps median ${info.medianGapMs} ms, p95 ${info.p95GapMs} ms, moments ${JSON.stringify(info.moments)}`);
  };

  await test.step("show: the agent draws the checkout flow", async () => {
    await openConversation(page, ids.explainCheckout);
    await page.waitForTimeout(500);
    await film("show", async () => {
      await recorder.markRect("composer", page.locator(".composer:visible"));
      await recorder.markRect("sidebar", page.locator("nav.sidebar"));
      await page.waitForTimeout(600);
      await sendOnCamera(page, cursor, recorder, prompts.explainCheckout);
      await expect(page.locator(".timeline:visible .tool-title").first()).toBeVisible();
      recorder.mark("firstTool");
      await expect(canvasPane(page).locator(".canvas-frame.show iframe").contentFrame().locator(".mermaid svg")).toBeVisible();
      recorder.mark("canvasShown");
      await recorder.markRect("canvas", canvasPane(page));
      await recorder.markRect("timeline", page.locator(".timeline:visible"));
      await cursor.glideTo({ x: 1150, y: 420 });
      await waitForTurnToEnd(page);
      recorder.mark("turnEnded");
      await page.waitForTimeout(2500);
    });
  });

  await test.step("overview: agents at work across the projects", async () => {
    await sendOffCamera(page, ids.settingsLayout, prompts.settingsLayout);
    await sendOffCamera(page, ids.translate, prompts.translate);
    await sendOffCamera(page, ids.postgres, prompts.runbook);
    await openConversation(page, ids.explainCheckout);
    await film("overview", async () => {
      await recorder.markRect("sidebar", page.locator("nav.sidebar"));
      await recorder.markRect("shop", page.locator(".workspace-group").first());
      await cursor.glideTo({ x: 420, y: 520 });
      await expect(sidebarItem(page, mobileApp, "Pick a settings layout")).toContainText("Needs you", { timeout: 30_000 });
      recorder.mark("needsYou");
      await expect(sidebarItem(page, storefront, "Translate the checkout pages")).toContainText("Done", { timeout: 30_000 });
      recorder.mark("translateDone");
      await expect(sidebarItem(page, infra, "Plan the Postgres 18 upgrade")).toContainText("Done", { timeout: 30_000 });
      recorder.mark("runbookDone");
      await cursor.glideToElement(sidebarItem(page, mobileApp, "Pick a settings layout"), { offsetX: 0.35 });
      await page.waitForTimeout(900);
    });
  });

  await test.step("ask: the agent asks with pictures", async () => {
    await film("ask", async () => {
      await page.waitForTimeout(400);
      await cursor.click(sidebarItem(page, mobileApp, "Pick a settings layout"), { offsetX: 0.35 });
      recorder.mark("opened");
      const ask = page.locator(".ask");
      await expect(ask.locator(".ask-option")).toHaveCount(3);
      await expect(page.locator(".ask-preview").last()).toBeVisible();
      await page.waitForTimeout(500);
      await recorder.markRect("question", canvasPane(page));
      await recorder.markRect("options", ask.locator(".ask-options"));
      recorder.mark("questionShown");
      const option = (label: string) => ask.locator(".ask-option", { hasText: label });
      await cursor.glideToElement(option("Search first"), { offsetY: 0.6 });
      await page.waitForTimeout(500);
      await cursor.glideToElement(option("Tabs per area"), { offsetY: 0.6 });
      await page.waitForTimeout(450);
      await cursor.click(option(LAYOUT_CHOICE).locator(".ask-option-label"));
      recorder.mark("picked");
      await page.waitForTimeout(500);
      await cursor.click(ask.getByRole("button", { name: "Submit" }));
      recorder.mark("submitted");
      await waitForTurnToEnd(page);
      recorder.mark("turnEnded");
      await recorder.markRect("timeline", page.locator(".timeline:visible"));
      await page.waitForTimeout(1800);
    });
  });

  await test.step("review: a guided tour of the change", async () => {
    await openConversation(page, ids.reviewRetries);
    await film("review", async () => {
      await page.waitForTimeout(400);
      await recorder.markRect("composer", page.locator(".composer:visible"));
      await sendOnCamera(page, cursor, recorder, prompts.review);
      const view = page.locator(".review");
      await expect(view.locator(".verdict")).toBeVisible();
      recorder.mark("reviewShown");
      await recorder.markRect("canvas", canvasPane(page));
      await recorder.markRect("verdict", view.locator(".verdict"));
      await page.waitForTimeout(1600);
      await cursor.click(view.getByRole("tab", { name: /Flow/ }));
      recorder.mark("flow");
      await page.waitForTimeout(900);
      await cursor.click(view.getByRole("navigation", { name: "Flow steps" }).getByText("The capture is retried"));
      recorder.mark("flowStep");
      await page.waitForTimeout(1800);
      await cursor.click(view.getByRole("tab", { name: /Findings/ }));
      recorder.mark("findings");
      await expect(view.locator(".finding").first()).toBeVisible();
      await recorder.markRect("blocker", view.locator(".finding").first());
      await cursor.glideToElement(view.locator(".finding").first().locator(".finding-title"));
      await waitForTurnToEnd(page);
      await page.waitForTimeout(2200);
    });
  });

  await test.step("edit: approve the change, then see what it touched", async () => {
    await openConversation(page, ids.stopDoubleCharge);
    await film("edit", async () => {
      await page.waitForTimeout(400);
      await sendOnCamera(page, cursor, recorder, prompts.fix);
      const approval = page.locator(".canvas-panel .edit-approval");
      await expect(approval).toBeVisible();
      recorder.mark("approval");
      await recorder.markRect("canvas", canvasPane(page));
      await page.waitForTimeout(1800);
      await cursor.click(approval.getByRole("button", { name: "Yes", exact: true }));
      recorder.mark("allowed");
      await waitForTurnToEnd(page);
      recorder.mark("turnEnded");
      await page.waitForTimeout(700);
      await cursor.click(canvasPane(page).getByRole("button", { name: "Changes" }));
      recorder.mark("changes");
      const changes = page.locator(".changes");
      const file = changes.getByRole("button", { name: /src\/checkout\.ts/ });
      await expect(file).toBeVisible();
      await expect(canvasPane(page).getByText(/Allowed: edit/)).toBeHidden({ timeout: 15_000 });
      await page.waitForTimeout(500);
      await cursor.click(file);
      await expect(changes.locator(".changes-diff")).toContainText("idempotencyKey");
      recorder.mark("diff");
      await recorder.markRect("changes", canvasPane(page));
      await page.waitForTimeout(2200);
    });
  });

  await test.step("terminals: a shell beside the conversation", async () => {
    await openConversation(page, ids.explainCheckout);
    await film("terminals", async () => {
      await page.waitForTimeout(400);
      await cursor.click(page.getByRole("button", { name: "Show terminal" }));
      recorder.mark("shown");
      const terminals = page.locator(".terminal-pane .terminal-splits.shown .xterm");
      await expect(terminals.first()).toBeVisible();
      await page.waitForTimeout(600);
      await cursor.click(terminals.first());
      await typeLikeAPerson(page, "git log --oneline --graph main retry-payments");
      await page.keyboard.press("Enter");
      recorder.mark("logged");
      await page.waitForTimeout(900);
      await cursor.click(page.getByRole("button", { name: "Split right" }));
      await expect(terminals).toHaveCount(2);
      await page.waitForTimeout(500);
      await cursor.click(terminals.nth(1));
      await typeLikeAPerson(page, "git diff --stat main");
      await page.keyboard.press("Enter");
      await expect(page.locator(".terminal-pane .terminal-splits.shown .xterm-rows").nth(1)).toContainText("changed");
      recorder.mark("diffed");
      await recorder.markRect("terminals", page.locator('[data-pane="terminals"]'));
      await page.waitForTimeout(2000);
    });
    await page.getByRole("button", { name: "Hide terminal" }).click();
  });

  await test.step("groups: put the workspaces in order", async () => {
    await film("groups", async () => {
      await recorder.markRect("sidebar", page.locator("nav.sidebar"));
      await page.waitForTimeout(400);
      await cursor.click(page.getByRole("button", { name: "New group" }));
      await typeLikeAPerson(page, "Platform");
      await page.keyboard.press("Enter");
      const platform = page.locator(".workspace-group", { has: page.locator(".group-name", { hasText: /^Platform$/ }) });
      await expect(platform).toBeVisible();
      recorder.mark("grouped");
      await page.waitForTimeout(600);
      await dragWorkspaceInto(page, cursor, workspaceCard(page, infra).locator(":scope > header"), platform.locator(":scope > header"));
      await expect(platform.locator("section.workspace")).toHaveCount(1);
      recorder.mark("moved");
      await page.waitForTimeout(1800);
    });
  });

  const strays = director.requests.filter(({ mainLoop, scripted }) => mainLoop && !scripted);
  expect(strays, "every turn the agents took came from a script").toEqual([]);
});

/** Drags a workspace by its heading onto the lower part of a group's heading, which puts it last in the group. */
async function dragWorkspaceInto(page: Page, cursor: Cursor, workspaceHeading: Locator, groupHeading: Locator) {
  await cursor.glideToElement(workspaceHeading, { offsetX: 0.3, offsetY: 0.4 });
  const target = (await groupHeading.boundingBox())!;
  await cursor.drag({ x: target.x + target.width * 0.4, y: target.y + target.height * 0.8 });
  await page.waitForTimeout(200);
}
