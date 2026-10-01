import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export async function hostAnswers(origin: string) {
  try {
    const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

export function spawnDetachedHost(argv: string[], workingDirectory: string, logPath: string) {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "a");
  const [executable, ...args] = argv;
  const child = spawn(executable!, args, { cwd: workingDirectory, detached: true, stdio: ["ignore", log, log] });
  child.on("error", () => {});
  child.unref();
  closeSync(log);
  if (child.pid === undefined) throw new Error(`Could not start the host in ${workingDirectory}. Check "hostDirectory" and "bun" in desktop.json.`);
  return child.pid;
}
