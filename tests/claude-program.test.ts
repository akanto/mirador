import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProgramLookUps, findClaudeProgram, versionOf } from "../host/acp/claude-program.ts";
import { launchEnvironment } from "../host/acp/harnesses.ts";
import type { ClaudeProgram, Profile } from "../shared/model.ts";
import { fakeProgram } from "./fake-program.ts";

const programIn = (directory: string, name: string, script = `console.log("9.9.9 (Claude Code)");`) => fakeProgram(directory, name, script);
const hangs = (seconds: number) => `setTimeout(() => {}, ${seconds * 1000});`;

const scratch = () => mkdtempSync(join(tmpdir(), "claude-program-"));

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** taskkill ends the program under a claude.cmd a moment after cmd.exe; a program sent SIGKILL is gone at once. */
const KILL_GRACE_MS = process.platform === "win32" ? 3_000 : 0;

async function runsOnAfter(pid: number, graceMs: number) {
  const deadline = Date.now() + graceMs;
  while (isRunning(pid) && Date.now() < deadline) await Bun.sleep(20);
  return isRunning(pid);
}

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
  const program = programIn(scratch(), "claude", hangs(30));
  const reports: ClaudeProgram[] = [];
  const lookUp = claudeProgramLookUps((reported) => reports.push(reported), 1000)(program);
  expect(reports).toEqual([{ configured: program, found: program, version: null }]);
  await lookUp;
});

test("a lookup overtaken by a newer one does not report over it", async () => {
  const directory = scratch();
  const hanging = programIn(directory, "hanging", hangs(30));
  const working = programIn(directory, "working");
  const reports: ClaudeProgram[] = [];
  const lookUp = claudeProgramLookUps((reported) => reports.push(reported), 4000);
  const staleLookUp = lookUp(hanging);
  await lookUp(working);
  await staleLookUp;
  expect(reports.at(-1)).toEqual({ configured: working, found: working, version: "9.9.9 (Claude Code)" });
}, 15_000);

test("a claude that hangs on --version is given up on and killed, on Windows with what its claude.cmd runs, and left as found with no version", async () => {
  const directory = scratch();
  const pidFile = join(directory, "pid");
  const hanging = programIn(directory, "hanging", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${hangs(30)}`);
  expect(await versionOf(hanging, 2000)).toBeNull();
  expect(existsSync(pidFile)).toBe(true);
  expect(await runsOnAfter(Number(readFileSync(pidFile, "utf8")), KILL_GRACE_MS)).toBe(false);
}, 15_000);

test("a version check is given up on within its timeout when a wrapper's child holds stdout open", async () => {
  const wrapper = programIn(scratch(), "wrapper", `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(hangs(6))}], { stdio: ["ignore", "inherit", "ignore"] }); ${hangs(6)}`);
  const started = Date.now();
  expect(await versionOf(wrapper, 2000)).toBeNull();
  expect(Date.now() - started).toBeLessThan(4000);
});

test("a version check is given up on within its timeout when the program ignores SIGTERM", async () => {
  const ignoresTerm = programIn(scratch(), "ignores-term", `process.on("SIGTERM", () => {}); ${hangs(5)}`);
  const started = Date.now();
  expect(await versionOf(ignoresTerm, 2000)).toBeNull();
  expect(Date.now() - started).toBeLessThan(4000);
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
