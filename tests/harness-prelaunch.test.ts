import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessProcess } from "../host/acp/harness.ts";

describe("HarnessProcess.start", () => {
  test("reports a failing pre-launch command with what it wrote, which it adds to the agent's log after the earlier lines", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mirador-prelaunch-"));
    const log = join(directory, "proxied.log");
    writeFileSync(log, "an earlier start\n");
    const harness = new HarnessProcess(
      {
        id: "claude",
        label: "Proxied agent",
        logName: "proxied",
        command: [process.execPath, "-e", ""],
        environment: { ...process.env } as Record<string, string>,
        prelaunch: "echo starting; echo 'proxy binary missing' >&2; exit 3",
        startsOneAtATime: false,
      },
      { onSessionUpdate: () => {}, onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }) as never, onExit: () => {} },
      directory,
    );
    await expect(harness.start()).rejects.toThrow("The pre-launch command of Proxied agent exited with 3: starting\nproxy binary missing");
    expect(readFileSync(log, "utf8")).toStartWith("an earlier start\nstarting\nproxy binary missing\n");
  }, 15_000);
});
