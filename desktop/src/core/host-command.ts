const HOST_ENTRY = "host/main.ts";

export function loginShell(env: Record<string, string | undefined>, accountShell: string | undefined) {
  return env.SHELL || accountShell || "/bin/zsh";
}

export function hostArgv(shell: string, bun: string, overrides: Record<string, string>) {
  const assignments = Object.entries(overrides).map(([name, value]) => `${name}=${value}`);
  const command = assignments.length > 0 ? ["/usr/bin/env", ...assignments, bun, HOST_ENTRY] : [bun, HOST_ENTRY];
  return [shell, "-ilc", 'exec "$0" "$@"', ...command];
}

/** `exec` keeps the pid, so a live host shows up in `ps` as just the bun invocation. */
export function isHostCommandLine(commandLine: string) {
  const suffix = ` ${HOST_ENTRY}`;
  if (!commandLine.endsWith(suffix)) return false;
  const executable = commandLine.slice(0, -suffix.length);
  return executable === "bun" || executable.endsWith("/bun");
}
