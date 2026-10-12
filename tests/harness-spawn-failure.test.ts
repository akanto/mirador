import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessProcess } from "../host/acp/harness.ts";

describe("HarnessProcess.start", () => {
  test("fails with why the agent could not start when its program isn't executable, and the harness counts as gone", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mirador-harness-spawn-"));
    const program = join(directory, "not-executable");
    writeFileSync(program, "#!/bin/sh\n", { mode: 0o644 });
    let exitedReason: string | null = null;
    const harness = new HarnessProcess(
      { id: "claude", label: "Unrunnable agent", logName: "unrunnable", command: [program], environment: {}, prelaunch: "", startsOneAtATime: false },
      { onSessionUpdate: () => {}, onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } } as never), onExit: (_harness, reason) => void (exitedReason = reason) },
      directory,
    );
    await expect(harness.start()).rejects.toThrow(/The Unrunnable agent agent process could not start: .*EACCES/);
    expect(exitedReason as string | null).toMatch(/could not start/);
    expect(await harness.stop()).toMatch(/could not start/);
  }, 15_000);
});
