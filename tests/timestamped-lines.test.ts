import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessProcess } from "../host/acp/harness.ts";
import { timestampedLines } from "../host/acp/timestamped-lines.ts";

const stampedOutputOf = async (chunks: (string | Buffer)[]) => {
  const stamp = timestampedLines(() => new Date("2026-10-27T09:00:00.000Z"));
  const output: Buffer[] = [];
  stamp.on("data", (piece: Buffer) => output.push(piece));
  const ended = new Promise((resolve) => stamp.on("end", resolve));
  chunks.forEach((chunk) => stamp.write(chunk));
  stamp.end();
  await ended;
  return Buffer.concat(output).toString();
};

describe("timestampedLines", () => {
  test("stamps every line once, even when a line arrives in pieces", async () => {
    expect(await stampedOutputOf(["first\nsec", "ond\n\nthi", "rd"])).toBe(
      "2026-10-27T09:00:00.000Z first\n" +
        "2026-10-27T09:00:00.000Z second\n" +
        "2026-10-27T09:00:00.000Z \n" +
        "2026-10-27T09:00:00.000Z third",
    );
  });

  test("keeps a character split across chunks whole", async () => {
    const accented = Buffer.from("é\n");
    expect(await stampedOutputOf([accented.subarray(0, 1), accented.subarray(1)])).toBe("2026-10-27T09:00:00.000Z é\n");
  });
});

describe("HarnessProcess.start", () => {
  test("writes the agent's output to its log with a timestamp on each line", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mirador-harness-log-"));
    const harness = new HarnessProcess(
      { id: "claude", label: "Noisy agent", logName: "noisy", command: [process.execPath, "-e", "console.error('one\\ntwo'); process.exit(3)"], environment: {}, prelaunch: "", startsOneAtATime: false },
      { onSessionUpdate: () => {}, onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } } as never), onExit: () => {} },
      directory,
    );
    await expect(harness.start()).rejects.toThrow(/exited with 3/);
    await Bun.sleep(100);
    const lines = readFileSync(join(directory, "noisy.log"), "utf8").trimEnd().split("\n");
    expect(lines.map((line) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /, ""))).toEqual(["one", "two"]);
  }, 15_000);
});
