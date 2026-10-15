import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProgramLookUps, findClaudeProgram, versionOf } from "../host/acp/claude-program.ts";
import { launchEnvironment } from "../host/acp/harnesses.ts";
import type { ClaudeProgram, Profile } from "../shared/model.ts";

function programIn(directory: string, name: string, script = "#!/bin/sh\necho '9.9.9 (Claude Code)'\n") {
  const path = join(directory, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

const scratch = () => mkdtempSync(join(tmpdir(), "claude-program-"));

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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
  const reports: ClaudeProgram[] = [];
  await claudeProgramLookUps((reported) => reports.push(reported))(program);
  expect(reports).toEqual([
    { configured: program, found: program, version: null },
    { configured: program, found: program, version: "9.9.9 (Claude Code)" },
  ]);

  const missing = join(scratch(), "missing");
  const missingReports: ClaudeProgram[] = [];
  await claudeProgramLookUps((reported) => missingReports.push(reported))(missing);
  expect(missingReports).toEqual([{ configured: missing, found: null, version: null }]);
});

test("Settings shows the program found while its version is still unknown", async () => {
  const program = programIn(scratch(), "claude", "#!/bin/sh\nexec sleep 30\n");
  const reports: ClaudeProgram[] = [];
  const lookUp = claudeProgramLookUps((reported) => reports.push(reported), 1000)(program);
  expect(reports).toEqual([{ configured: program, found: program, version: null }]);
  await lookUp;
});

test("a lookup overtaken by a newer one does not report over it", async () => {
  const directory = scratch();
  const hanging = programIn(directory, "hanging", "#!/bin/sh\nexec sleep 30\n");
  const working = programIn(directory, "working");
  const reports: ClaudeProgram[] = [];
  const lookUp = claudeProgramLookUps((reported) => reports.push(reported), 2000);
  const staleLookUp = lookUp(hanging);
  await lookUp(working);
  await staleLookUp;
  expect(reports.at(-1)).toEqual({ configured: working, found: working, version: "9.9.9 (Claude Code)" });
});

test("a claude that hangs on --version is given up on, killed and left as found with no version", async () => {
  const directory = scratch();
  const pidFile = join(directory, "pid");
  const hanging = programIn(directory, "hanging", `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 30\n`);
  expect(await versionOf(hanging, 2000)).toBeNull();
  expect(existsSync(pidFile)).toBe(true);
  expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
});

test("a version check is given up on within its timeout when a wrapper's child holds stdout open", async () => {
  const wrapper = programIn(scratch(), "wrapper", "#!/bin/sh\nsleep 6\n");
  const started = Date.now();
  expect(await versionOf(wrapper, 2000)).toBeNull();
  expect(Date.now() - started).toBeLessThan(4000);
});

test("a version check is given up on within its timeout when the program ignores SIGTERM", async () => {
  const ignoresTerm = programIn(scratch(), "ignores-term", "#!/bin/sh\ntrap '' TERM\nexec sleep 5\n");
  const started = Date.now();
  expect(await versionOf(ignoresTerm, 2000)).toBeNull();
  expect(Date.now() - started).toBeLessThan(4000);
});

test.if(process.platform === "win32")("on Windows a claude.cmd that hangs on --version is given up on, and the program it runs ends with it", async () => {
  const directory = scratch();
  const pidFile = join(directory, "pid");
  writeFileSync(join(directory, "claude.js"), `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30_000);`);
  const claude = join(directory, "claude.cmd");
  writeFileSync(claude, `@"${process.execPath}" "%~dp0claude.js" %*\r\n`);

  expect(await versionOf(claude, 2000)).toBeNull();
  expect(existsSync(pidFile)).toBe(true);
  const program = Number(readFileSync(pidFile, "utf8"));
  const deadline = Date.now() + 3_000;
  while (isRunning(program) && Date.now() < deadline) await Bun.sleep(20);
  expect(isRunning(program)).toBe(false);
}, 15_000);

test("Claude Code's agent is told which program to run, a profile may name its own, and a missing one says how to install it", () => {
  const program = programIn(scratch(), "claude");
  expect(launchEnvironment("claude", null, program).CLAUDE_CODE_EXECUTABLE).toBe(program);
  expect(launchEnvironment("opencode", null, program).CLAUDE_CODE_EXECUTABLE).toBeUndefined();

  const profile = { name: "Work", environment: "CLAUDE_CODE_EXECUTABLE=/opt/work/claude" } as Profile;
  expect(launchEnvironment("claude", profile, program).CLAUDE_CODE_EXECUTABLE).toBe("/opt/work/claude");

  const missing = join(scratch(), "missing");
  expect(() => launchEnvironment("claude", null, missing)).toThrow(`The Claude Code program set in Settings › Agents, ${missing}, does not exist or cannot run.`);
});
