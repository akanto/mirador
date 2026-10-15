import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childProgramNames, descendantsOf, killProcessTree, parseProcessSnapshot, type WindowsProcess } from "../host/windows-processes.ts";
import { fakeProgram } from "./fake-program.ts";

const started = (pid: number, parentPid: number, startedAt: number, name = `program-${pid}.exe`): WindowsProcess => ({ pid, parentPid, startedAt, name });

describe("a Windows process tree", () => {
  test("holds what a process started, at any depth", () => {
    const processes = [started(10, 1, 100), started(20, 10, 200), started(30, 20, 300), started(40, 1, 150)];
    expect(descendantsOf(10, processes).map(({ pid }) => pid)).toEqual([20, 30]);
  });

  test("leaves out an older process that names the pid as its parent, as one whose parent exited before the pid was reused does", () => {
    const shell = started(816, 700, 5_000, "pwsh.exe");
    const systemProcess = started(844, 816, 1_000, "csrss.exe");
    const startedBySystemProcess = started(900, 844, 1_100, "winlogon.exe");
    const program = started(950, 816, 6_000, "bun.exe");
    expect(descendantsOf(816, [systemProcess, startedBySystemProcess, shell, program])).toEqual([program]);
  });

  test("is empty for a pid no process has", () => {
    expect(descendantsOf(5, [started(10, 5, 100)])).toEqual([]);
  });

  test("is read from lines of pid, parent pid, start time and name, a name with spaces included", () => {
    const snapshot = "0 0 0 System Idle Process\r\n4 0 0 System\r\n6704 6632 1760405328234000 explorer.exe\r\n\r\n";
    expect(parseProcessSnapshot(snapshot)).toEqual([
      started(0, 0, 0, "System Idle Process"),
      started(4, 0, 0, "System"),
      started(6704, 6632, 1760405328234000, "explorer.exe"),
    ]);
  });
});

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.if(process.platform === "win32")("on Windows a cmd.exe's programs are named, and killing its tree ends what they started too", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mirador-process-tree-"));
  const startingAnother = "const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60000)']); console.log(child.pid); await child.exited";
  const viaCmd = Bun.spawn([fakeProgram(directory, "starter", startingAnother)], { stdout: "pipe" });
  const grandchild = Number(new TextDecoder().decode((await viaCmd.stdout.getReader().read()).value).trim());
  try {
    expect(await childProgramNames(viaCmd.pid)).toContain("bun");
    await killProcessTree(viaCmd.pid);
    await viaCmd.exited;
    const deadline = Date.now() + 5_000;
    while (isRunning(grandchild) && Date.now() < deadline) await Bun.sleep(50);
    expect(isRunning(grandchild)).toBe(false);
  } finally {
    if (isRunning(grandchild)) process.kill(grandchild);
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
