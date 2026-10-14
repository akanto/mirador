import { expect, test } from "bun:test";
import { errorMessage } from "../host/conversations.ts";

test("an error line leaves out the kind Claude Code tags its errors with, and keeps any other details", () => {
  const apiError = "Internal error: API Error: 502 Bad Gateway. This is a server-side issue, usually temporary.";
  expect(errorMessage({ message: apiError, data: { errorKind: "server_error" } })).toBe(apiError);
  expect(errorMessage({ message: "Invalid params", data: { errorKind: "invalid", field: "cwd" } })).toBe('Invalid params: {"field":"cwd"}');
  expect(errorMessage({ message: "Agent failed", data: "spawn claude ENOENT" })).toBe("Agent failed: spawn claude ENOENT");
  expect(errorMessage({ message: "Exit", data: 1 })).toBe("Exit: 1");
  expect(errorMessage({ message: "Missing", data: ["cwd", "mcpServers"] })).toBe('Missing: ["cwd","mcpServers"]');
  expect(errorMessage("plain")).toBe("plain");
});
