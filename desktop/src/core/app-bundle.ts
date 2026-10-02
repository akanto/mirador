/** What the system should start to open this app: the .app bundle on macOS, the launcher beside the runtime on Linux. */
export function installedAppPath(executablePath: string, platform: NodeJS.Platform = process.platform) {
  if (platform === "darwin") return executablePath.match(/^(.*\.app)\/Contents\//)?.[1] ?? null;
  const binDirectory = executablePath.match(/^(.*\/app\/bin)\/[^/]+$/)?.[1];
  return binDirectory ? `${binDirectory}/launcher` : null;
}
