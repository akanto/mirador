import { dlopen, FFIType } from "bun:ffi";
import { programName } from "./command-shell.ts";

export type WindowsProcess = { pid: number; parentPid: number; startedAt: number; name: string };

const TH32CS_SNAPPROCESS = 0x2;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** PROCESSENTRY32W as 64-bit Windows lays it out. */
const PROCESS_ENTRY = { size: 568, pid: 8, parentPid: 32, exeFile: 44, exeFileBytes: 520 } as const;
/** A FILETIME counts 100 ns intervals since 1601. */
const FILETIME_AT_1970 = 116444736000000000n;
const UTF16 = new TextDecoder("utf-16le");

const openKernel32 = () =>
  dlopen("kernel32.dll", {
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
    Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  }).symbols;

let kernel32Functions: ReturnType<typeof openKernel32> | undefined;
/** kernel32 is there only on Windows, so it is opened at its first use rather than as the module loads. */
const kernel32 = () => (kernel32Functions ??= openKernel32());

function* processEntries(snapshot: bigint) {
  const { Process32FirstW, Process32NextW } = kernel32();
  const entry = new Uint8Array(PROCESS_ENTRY.size);
  const fields = new DataView(entry.buffer);
  fields.setUint32(0, PROCESS_ENTRY.size, true);
  for (let found = Process32FirstW(snapshot, entry); found; found = Process32NextW(snapshot, entry)) {
    const exeFile = UTF16.decode(entry.subarray(PROCESS_ENTRY.exeFile, PROCESS_ENTRY.exeFile + PROCESS_ENTRY.exeFileBytes));
    yield { pid: fields.getUint32(PROCESS_ENTRY.pid, true), parentPid: fields.getUint32(PROCESS_ENTRY.parentPid, true), name: exeFile.split("\0")[0]! };
  }
}

/** When the process started, in microseconds since 1970; null for one this account may not look into. */
function startOf(pid: number): number | null {
  const { OpenProcess, GetProcessTimes, CloseHandle } = kernel32();
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle === 0n) return null;
  const creation = new BigUint64Array(1);
  const unused = () => new BigUint64Array(1);
  const known = GetProcessTimes(handle, creation, unused(), unused(), unused());
  CloseHandle(handle);
  return known ? Number((creation[0]! - FILETIME_AT_1970) / 10n) : null;
}

/** Every running process this account can see the start of: one it cannot is not one Mirador started. */
export function processSnapshot(): WindowsProcess[] {
  const snapshot = kernel32().CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot === INVALID_HANDLE_VALUE) return [];
  try {
    return [...processEntries(snapshot)].flatMap((entry) => {
      const startedAt = startOf(entry.pid);
      return startedAt === null ? [] : [{ ...entry, startedAt }];
    });
  } finally {
    kernel32().CloseHandle(snapshot);
  }
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

/** Windows has no hangup and no process groups: a process and everything it started end together only this way. */
export async function killProcessTree(pid: number) {
  const tree = [pid, ...descendantsOf(pid, processSnapshot()).map((process) => process.pid)];
  await Bun.spawn(["taskkill", "/F", ...tree.flatMap((member) => ["/PID", String(member)])], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
}

/** The programs `pid` started that still run, by name. */
export function childProgramNames(pid: number): string[] {
  const processes = processSnapshot();
  const parent = processes.find((process) => process.pid === pid);
  return parent ? childrenOf(parent, processes).map(({ name }) => programName(name)) : [];
}
