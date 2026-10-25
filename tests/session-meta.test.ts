import { expect, test } from "bun:test";
import { claudeSessionMeta, piSessionMeta, sessionMeta } from "../host/acp/harnesses.ts";
import { canvasInstructions, canvasUseGuidance } from "../host/canvas/guidance.ts";
import type { CanvasUse } from "../shared/model.ts";

test("Claude Code runs every tool of the canvas's own without a permission prompt", () => {
  expect(claudeSessionMeta("often").claudeCode.options.allowedTools).toEqual([
    "mcp__canvas__show",
    "mcp__canvas__ask",
    "mcp__canvas__review",
    "mcp__canvas__update_review",
    "mcp__canvas__when_done",
  ]);
});

const ASSETS_ORIGIN = "https://assets.example:4601";
const appendedForPi = (canvasUse: CanvasUse) => piSessionMeta(canvasUse, ASSETS_ORIGIN).systemPrompt.append;

test("pi gets the canvas server's instructions, and the canvas guidance only when Settings ask for the canvas often", () => {
  expect(appendedForPi("as-needed")).toContain(canvasInstructions(ASSETS_ORIGIN));
  expect(appendedForPi("as-needed")).not.toContain(canvasUseGuidance());
  expect(appendedForPi("often")).toContain(canvasUseGuidance());
});

test("pi waits for jobs with the canvas's when_done tool, as its commands can't name their session to mirador when-done", () => {
  expect(appendedForPi("often")).not.toContain("mirador when-done");
});

test("opencode gets no session options", () => {
  expect(sessionMeta("opencode", "often", { canvasAssetsOrigin: ASSETS_ORIGIN })).toBeUndefined();
});
