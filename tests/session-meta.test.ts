import { expect, test } from "bun:test";
import { sessionMeta } from "../host/acp/harnesses.ts";

test("Claude Code runs every canvas tool without a permission prompt", () => {
  expect(sessionMeta("claude", "often")?.claudeCode.options.allowedTools).toEqual([
    "mcp__canvas__show",
    "mcp__canvas__ask",
    "mcp__canvas__review",
    "mcp__canvas__update_review",
    "mcp__canvas__when_done",
  ]);
});
