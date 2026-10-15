export function systemOpenCommand(file: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["open", file];
  if (platform === "win32") return ["cmd", "/c", "start", "", file];
  return ["xdg-open", file];
}

export function openWithSystemDefault(file: string) {
  Bun.spawn(systemOpenCommand(file), { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
}
