import { execFileSync } from "node:child_process";

const POLL_INTERVAL_MS = 100;
const KILLED_PROCESSES_EXIT_MS = 2_000;

interface RunningProcess {
  pid: number;
  parentPid: number;
  startedAt: string;
}

/** Processes by pid, each with when it started: a later process that gets the same pid is not one of them. */
export type ProcessTree = ReadonlyMap<number, string>;

/** Every process on this computer that still runs; zombies are left out, as they have ended and only wait to be reaped. */
function runningProcesses(): RunningProcess[] {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat=,lstart="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, , state]) => !state.startsWith("Z"))
    .map(([pid, parentPid, , ...startedAt]) => ({ pid: Number(pid), parentPid: Number(parentPid), startedAt: startedAt.join(" ") }));
}

function withDescendants(tree: ProcessTree, processes: RunningProcess[]): ProcessTree {
  const children = processes.filter(({ pid, parentPid }) => tree.has(parentPid) && !tree.has(pid));
  const grown = new Map([...tree, ...children.map(({ pid, startedAt }) => [pid, startedAt] as const)]);
  return children.length === 0 ? grown : withDescendants(grown, processes);
}

function stillRunningWithDescendants(tree: ProcessTree): ProcessTree {
  const processes = runningProcesses();
  const stillRunning = processes.filter(({ pid, startedAt }) => tree.get(pid) === startedAt);
  return withDescendants(new Map(stillRunning.map(({ pid, startedAt }) => [pid, startedAt])), processes);
}

/** The process, if it still runs, and every process it started, at any depth. */
export function processTreeOf(pid: number): ProcessTree {
  const processes = runningProcesses();
  const root = processes.find((running) => running.pid === pid);
  return root ? withDescendants(new Map([[pid, root.startedAt]]), processes) : new Map();
}

async function stillRunningAfter(tree: ProcessTree, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let running = stillRunningWithDescendants(tree);
  while (running.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    running = stillRunningWithDescendants(running);
  }
  return running;
}

function killIfStillRunning(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

/**
 * Waits until none of these processes runs any more, nor any process they start meanwhile. Those still running when the
 * time is up are killed outright.
 */
export async function waitForProcessesToEnd(tree: ProcessTree, timeoutMs: number) {
  const survivors = await stillRunningAfter(tree, timeoutMs);
  [...survivors.keys()].forEach(killIfStillRunning);
  await stillRunningAfter(survivors, KILLED_PROCESSES_EXIT_MS);
}
