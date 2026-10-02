/** Shown under a workspace's name: the folder that holds it, with the home directory as ~. */
export function parentFolder(path: string, homeDir: string): string {
  const parent = path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
  if (homeDir && parent === homeDir) return "~";
  return homeDir && parent.startsWith(`${homeDir}/`) ? `~${parent.slice(homeDir.length)}` : parent;
}
