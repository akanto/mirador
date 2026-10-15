import { programName } from "./command-shell.ts";

/** Windows has no hangup and no process groups: a process and everything it started end together only this way. */
export function killProcessTree(pid: number) {
  return Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
}

/** The programs `pid` started that still run, by name; a CIM query, which takes about a second. */
export async function childProgramNames(pid: number): Promise<string[]> {
  const query = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { $_.Name }`;
  const children = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query], { stdout: "pipe", stderr: "ignore", windowsHide: true });
  const names = await new Response(children.stdout).text();
  return names.split(/\r?\n/).filter((name) => name.trim()).map((name) => programName(name.trim()));
}
