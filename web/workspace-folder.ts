/** The path with the home directory as ~; as it is outside home, and until the host has said where home is. */
export function withHomeAsTilde(path: string, homeDir: string): string {
  if (homeDir && path === homeDir) return "~";
  return homeDir && path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path;
}

/** Shown under a workspace's name: the folder that holds it, with the home directory as ~. */
export function parentFolder(path: string, homeDir: string): string {
  return withHomeAsTilde(path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/", homeDir);
}
