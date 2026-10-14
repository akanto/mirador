const HOST_ENTRY = "host/main.ts";

export function loginShell(env: Record<string, string | undefined>, accountShell: string | undefined) {
  return env.SHELL || accountShell || "/bin/sh";
}

/** The login shell runs the user's rc files, and one may cd elsewhere, so the host goes back to its directory before it starts. */
export function hostArgv(shell: string, bun: string, overrides: Record<string, string>, hostDirectory: string) {
  const assignments = Object.entries(overrides).map(([name, value]) => `${name}=${value}`);
  const command = assignments.length > 0 ? ["/usr/bin/env", ...assignments, bun, HOST_ENTRY] : [bun, HOST_ENTRY];
  return [shell, "-ilc", 'cd -- "$0" && exec "$@"', hostDirectory, ...command];
}

/** `exec` keeps the pid, so a live host shows up in `ps` as just the bun invocation. */
export function isHostCommandLine(commandLine: string) {
  const suffix = ` ${HOST_ENTRY}`;
  if (!commandLine.endsWith(suffix)) return false;
  const executable = commandLine.slice(0, -suffix.length);
  return executable === "bun" || executable.endsWith("/bun");
}
