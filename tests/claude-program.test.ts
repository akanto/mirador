import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeClaudeProgram, findClaudeProgram, versionOf } from "../host/acp/claude-program.ts";
import { launchEnvironment } from "../host/acp/harnesses.ts";
import type { Profile } from "../shared/model.ts";

function programIn(directory: string, name: string, script = "#!/bin/sh\necho '9.9.9 (Claude Code)'\n") {
  const path = join(directory, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

const scratch = () => mkdtempSync(join(tmpdir(), "claude-program-"));

test("without a program set, claude is found on PATH; a program set in Settings is used only if it can run", () => {
  const onPath = scratch();
  const claude = programIn(onPath, "claude");
  expect(findClaudeProgram("", onPath)).toBe(claude);

  const elsewhere = programIn(scratch(), "claude-nightly");
  expect(findClaudeProgram(elsewhere, onPath)).toBe(elsewhere);
  expect(findClaudeProgram(join(scratch(), "missing"), onPath)).toBeNull();
});

test("Settings shows the program found and the version it reports", async () => {
  const program = programIn(scratch(), "claude");
  expect(await describeClaudeProgram(program)).toEqual({ configured: program, found: program, version: "9.9.9 (Claude Code)" });
  const missing = join(scratch(), "missing");
  expect(await describeClaudeProgram(missing)).toEqual({ configured: missing, found: null, version: null });
});

test("a claude that hangs on --version is given up on, killed and left as found with no version", async () => {
  const directory = scratch();
  const pidFile = join(directory, "pid");
  const hanging = programIn(directory, "hanging", `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 30\n`);
  expect(await versionOf(hanging, 1000)).toBeNull();
  expect(existsSync(pidFile)).toBe(true);
  expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
});

test("Claude Code's agent is told which program to run, a profile may name its own, and a missing one says how to install it", () => {
  const program = programIn(scratch(), "claude");
  expect(launchEnvironment("claude", null, program).CLAUDE_CODE_EXECUTABLE).toBe(program);
  expect(launchEnvironment("opencode", null, program).CLAUDE_CODE_EXECUTABLE).toBeUndefined();

  const profile = { name: "Work", environment: "CLAUDE_CODE_EXECUTABLE=/opt/work/claude" } as Profile;
  expect(launchEnvironment("claude", profile, program).CLAUDE_CODE_EXECUTABLE).toBe("/opt/work/claude");

  const missing = join(scratch(), "missing");
  expect(() => launchEnvironment("claude", null, missing)).toThrow(`The Claude Code program set in Settings › Agents, ${missing}, does not exist or cannot run.`);
});
