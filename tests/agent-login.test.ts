import { expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { isAuthRequiredError, loginCommand } from "../host/acp/harnesses.ts";

test("a prompt the agent refuses until the user signs in again is told apart from other failures", () => {
  expect(isAuthRequiredError(RequestError.authRequired())).toBe(true);
  expect(isAuthRequiredError(RequestError.authRequired(undefined, "Please run /login"))).toBe(true);
  expect(isAuthRequiredError(RequestError.internalError())).toBe(false);
  expect(isAuthRequiredError(new Error("Authentication required"))).toBe(false);
});

test("Claude Code signs in with the program the agent runs, inside a wrapper that keeps a failure on screen", () => {
  const [shell, flag, script, name, ...command] = loginCommand("claude", { CLAUDE_CODE_EXECUTABLE: "/opt/claude/bin/claude" });
  expect([shell, flag, name]).toEqual(["/bin/sh", "-c", "mirador-login"]);
  expect(script).toContain("Press Enter to close this tab.");
  expect(command).toEqual(["/opt/claude/bin/claude", "auth", "login"]);
});
