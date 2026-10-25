import { describe, expect, test } from "bun:test";
import { stopsAtAnnouncedStep } from "../host/conversations.ts";

describe("a reply that stops at a step it announced", () => {
  test("ends in a colon, past any closing emphasis or blank space", () => {
    expect(stopsAtAnnouncedStep("Watcher missed (fast round). Closing r834 IN-TURN — step (a) verify:")).toBe(true);
    expect(stopsAtAnnouncedStep("FOLD-94 landing 16435 EXACT. Building + launching r833:\n")).toBe(true);
    expect(stopsAtAnnouncedStep("**Next step:**  ")).toBe(true);
  });

  test("is not one that finished, said nothing, or has a colon inside its last words", () => {
    expect(stopsAtAnnouncedStep("All 12 tests pass now.")).toBe(false);
    expect(stopsAtAnnouncedStep("PONG")).toBe(false);
    expect(stopsAtAnnouncedStep("")).toBe(false);
    expect(stopsAtAnnouncedStep("The build finished at 14:30")).toBe(false);
    expect(stopsAtAnnouncedStep("Warnings: 3")).toBe(false);
    expect(stopsAtAnnouncedStep("Set `retries:`")).toBe(false);
  });
});
