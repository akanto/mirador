import { expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { isAuthRequiredError, loginCommand } from "../host/acp/harnesses.ts";

test("a prompt the agent refuses until the user signs in again is told apart from other failures", () => {
  expect(isAuthRequiredError(RequestError.authRequired())).toBe(true);
  expect(isAuthRequiredError(RequestError.authRequired(undefined, "Please run /login"))).toBe(true);
  expect(isAuthRequiredError(RequestError.internalError())).toBe(false);
  expect(isAuthRequiredError(new Error("Authentication required"))).toBe(false);
});

test("Claude Code signs in through the agent's own bundled CLI, inside a wrapper that keeps a failure on screen", () => {
  const [shell, flag, script, name, ...command] = loginCommand("claude");
  expect([shell, flag, name]).toEqual(["/bin/sh", "-c", "mirador-login"]);
  expect(script).toContain("Press Enter to close this tab.");
  expect(command.slice(0, 2)).toEqual([process.execPath, expect.stringMatching(/claude-agent-acp\/dist\/index\.js$/)]);
  expect(command.slice(2)).toEqual(["--cli", "auth", "login"]);
});
