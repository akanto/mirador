import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processTreeOf, waitForProcessesToEnd, type ProcessTree } from "../e2e/process-tree.ts";

/** The e2e suite reads processes with ps, which Windows does not have; it runs there once it reads them another way. */
const describeOnceTheE2eSuiteRunsOnWindows = describe.todoIf(process.platform === "win32");

const startedTrees: ProcessTree[] = [];
const directories: string[] = [];

function killIfRunning(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

afterEach(() => {
  startedTrees.splice(0).forEach((tree) => [...tree.keys()].forEach(killIfRunning));
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

/** sh → sh → sleep, the sleep ignoring SIGTERM as a wedged agent does: gives the outermost process and the sleep's pid. */
async function startNestedProcesses(seconds: number) {
  const directory = mkdtempSync(join(tmpdir(), "mirador-process-tree-"));
  directories.push(directory);
  const innermostPidFile = join(directory, "innermost.pid");
  const inner = join(directory, "inner.sh");
  const middle = join(directory, "middle.sh");
  writeFileSync(inner, `trap '' TERM\necho $$ > '${innermostPidFile}.partial'\nmv '${innermostPidFile}.partial' '${innermostPidFile}'\nexec sleep ${seconds}\n`);
  writeFileSync(middle, `sh '${inner}' &\nwait\n`);
  const outer = spawn("sh", ["-c", `sh '${middle}' & wait`], { stdio: "ignore" });
  while (!existsSync(innermostPidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
  startedTrees.push(processTreeOf(outer.pid!));
  return { outer, innermost: Number(readFileSync(innermostPidFile, "utf8")) };
}

describeOnceTheE2eSuiteRunsOnWindows("processTreeOf", () => {
  test("holds a process and the processes it started, at any depth", async () => {
    const { outer, innermost } = await startNestedProcesses(30);
    const tree = processTreeOf(outer.pid!);
    expect(tree.has(outer.pid!)).toBe(true);
    expect(tree.has(innermost)).toBe(true);
    expect(tree.size).toBeGreaterThanOrEqual(3);
  });
});

describeOnceTheE2eSuiteRunsOnWindows("waitForProcessesToEnd", () => {
  test("waits for processes that outlive the one that started them", async () => {
    const { outer, innermost } = await startNestedProcesses(3);
    const tree = processTreeOf(outer.pid!);
    outer.kill("SIGKILL");
    expect(processTreeOf(innermost).size).toBe(1);
    await waitForProcessesToEnd(tree, 10_000);
    expect(processTreeOf(innermost).size).toBe(0);
  }, 15_000);

  test("leaves alone a process that got the pid of one that ended", async () => {
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    startedTrees.push(processTreeOf(other.pid!));
    await waitForProcessesToEnd(new Map([[other.pid!, "a start time that is not its own"]]), 300);
    expect(processTreeOf(other.pid!).size).toBe(1);
  });

  test("kills what still runs when the time is up", async () => {
    const { outer, innermost } = await startNestedProcesses(60);
    const startedAt = Date.now();
    await waitForProcessesToEnd(processTreeOf(outer.pid!), 300);
    expect(processTreeOf(innermost).size).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
