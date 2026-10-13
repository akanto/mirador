import { describe, expect, test } from "bun:test";
import { hookMessageIn, hookName } from "../web/hook-message.ts";

describe("hookMessageIn", () => {
  test("names the hook once and keeps each line without its prefix, empty lines too", () => {
    const text = "**Notice:** SessionStart:compact says: <persisted-output>\nSessionStart:compact says: \nSessionStart:compact says: Mode: code\n";
    expect(hookMessageIn(text)).toEqual({ level: "Notice", hook: "SessionStart:compact", lines: ["<persisted-output>", "", "Mode: code"] });
  });

  test("takes a hook without a matcher, and one whose matcher has characters of its own", () => {
    expect(hookMessageIn("Stop says: done")).toEqual({ level: null, hook: "Stop", lines: ["done"] });
    expect(hookMessageIn("**Warning:** PostToolUse:Edit|Write says: formatted\r\nPostToolUse:Edit|Write says: 2 files")).toEqual({
      level: "Warning",
      hook: "PostToolUse:Edit|Write",
      lines: ["formatted", "2 files"],
    });
  });

  test("names a level stronger than a notice before the hook", () => {
    expect(hookName({ level: "Warning", hook: "Stop", lines: [] })).toBe("Warning: Stop hook");
    expect(hookName({ level: "Notice", hook: "Stop", lines: [] })).toBe("Stop hook");
    expect(hookName({ level: null, hook: "Stop", lines: [] })).toBe("Stop hook");
  });

  test("leaves text alone unless every line comes from the same hook", () => {
    expect(hookMessageIn("**Notice:** Context left until auto-compact: 10%")).toBeNull();
    expect(hookMessageIn("SessionStart:compact says: one\nsomething else")).toBeNull();
    expect(hookMessageIn("SessionStart:compact says: one\nStop says: two")).toBeNull();
  });
});
