import { programName } from "./command-shell.ts";

export type WindowsProcess = { pid: number; parentPid: number; startedAt: number; name: string };

const UNIX_EPOCH_TICKS = 621355968000000000;
const SNAPSHOT_QUERY = `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { [long](($_.CreationDate.ToUniversalTime().Ticks - ${UNIX_EPOCH_TICKS}) / 10) } else { 0 }) $($_.Name)" }`;

/** Lines of `pid parentPid startedAt name`, the start in microseconds since 1970, where a name may hold spaces. */
export function parseProcessSnapshot(text: string): WindowsProcess[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const [, pid, parentPid, startedAt, name] = line.trim().match(/^(\d+) (\d+) (\d+) (.+)$/) ?? [];
    return pid ? [{ pid: Number(pid), parentPid: Number(parentPid), startedAt: Number(startedAt), name: name! }] : [];
  });
}

/**
 * The processes `parent` started. Windows keeps a process's parent pid after that parent exits, and gives the pid to
 * later processes, so a process only counts as a child of one that started before it.
 */
const childrenOf = (parent: WindowsProcess, processes: WindowsProcess[]) =>
  processes.filter(({ parentPid, startedAt }) => parentPid === parent.pid && startedAt > parent.startedAt);

/** The processes `pid` started, and the ones they started, at any depth. */
export function descendantsOf(pid: number, processes: WindowsProcess[]): WindowsProcess[] {
  const descendantsBelow = (parent: WindowsProcess): WindowsProcess[] =>
    childrenOf(parent, processes).flatMap((child) => [child, ...descendantsBelow(child)]);
  const root = processes.find((process) => process.pid === pid);
  return root ? descendantsBelow(root) : [];
}

async function takeProcessSnapshot() {
  const query = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SNAPSHOT_QUERY], { stdout: "pipe", stderr: "ignore", windowsHide: true });
  return parseProcessSnapshot(await new Response(query.stdout).text());
}

let snapshotInFlight: Promise<WindowsProcess[]> | null = null;

/**
 * Every running process. The CIM query takes about a second, so the calls made meanwhile share it: a host that stops
 * runs one for all its shells and agents at once, within its time to stop.
 */
function processSnapshot() {
  snapshotInFlight ??= takeProcessSnapshot().finally(() => (snapshotInFlight = null));
  return snapshotInFlight;
}

/** Windows has no hangup and no process groups: a process and everything it started end together only this way. */
export async function killProcessTree(pid: number) {
  const tree = [pid, ...descendantsOf(pid, await processSnapshot()).map((process) => process.pid)];
  await Bun.spawn(["taskkill", "/F", ...tree.flatMap((member) => ["/PID", String(member)])], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
}

/** The programs `pid` started that still run, by name. */
export async function childProgramNames(pid: number): Promise<string[]> {
  const processes = await processSnapshot();
  const parent = processes.find((process) => process.pid === pid);
  return parent ? childrenOf(parent, processes).map(({ name }) => programName(name)) : [];
}
